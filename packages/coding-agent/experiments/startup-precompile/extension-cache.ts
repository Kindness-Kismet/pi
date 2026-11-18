// Cache transformed extension bundles by content and compiler policy.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, spawn } from "bun";
import type { Jiti } from "jiti";
import jitiMetadata from "jiti/package.json" with { type: "json" };
import { type BundleRequest, type BundleResult, type Observation, readObservation } from "./extension-observations.ts";

const compilerBuild = await build({
	entrypoints: [fileURLToPath(new URL("./extension-bundle.ts", import.meta.url))],
	target: "bun",
	format: "esm",
	minify: true,
});
const compilerSource = await compilerBuild.outputs[0].text();
const version = `precompile-8:${process.versions.bun}:${jitiMetadata.version}:${hash(compilerSource)}`;

interface Artifact {
	version: string;
	policy: string;
	external: string[];
	observations: Observation[];
	bundleHash: string;
	codeHash: string;
	code: string;
}

/** Reuse valid transformed code without executing extension factories. */
export async function prepareCompiledExtension(
	filename: string,
	virtualModules: Record<string, unknown>,
	jiti: Jiti,
	cacheDirectory: string,
): Promise<string | undefined> {
	// Separate compiler generations so another installed binary cannot replace this cache.
	const generationDirectory = join(cacheDirectory, hash(version));
	mkdirSync(generationDirectory, { recursive: true });
	const cachedFile = join(generationDirectory, `${hash(filename)}.json`);
	const external = Object.keys(virtualModules).sort();
	const policy = JSON.stringify({
		transformOptions: jiti.options.transformOptions,
		jsx: jiti.options.jsx,
		interopDefault: jiti.options.interopDefault,
		sourceMaps: jiti.options.sourceMaps,
	});
	let cached: Artifact | undefined;
	try {
		// The version and code digest gate the persisted cache trust boundary.
		const artifact = JSON.parse(readFileSync(cachedFile, "utf8")) as Partial<Artifact> | null;
		if (
			artifact?.version === version &&
			typeof artifact.code === "string" &&
			artifact.codeHash === hash(artifact.code) &&
			typeof artifact.policy === "string" &&
			typeof artifact.bundleHash === "string" &&
			Array.isArray(artifact.external) &&
			artifact.external.every((specifier) => typeof specifier === "string") &&
			Array.isArray(artifact.observations) &&
			artifact.observations.every(
				(observation) =>
					observation !== null &&
					typeof observation === "object" &&
					["input", "package", "directory", "config"].includes(observation.kind) &&
					typeof observation.filename === "string" &&
					typeof observation.value === "string",
			)
		) {
			// All persisted fields used below have passed the cache schema boundary.
			cached = artifact as Artifact;
			if (
				cached.policy === policy &&
				JSON.stringify(cached.external) === JSON.stringify(external) &&
				cached.observations.every((observation) => readObservation(observation) === observation.value)
			)
				return cached.code;
		}
	} catch (error) {
		if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	// Bun's resolver cache is shared across builds and Workers; a process owns a fresh resolver.
	const child = spawn([process.execPath, "--eval", compilerSource], {
		env: { ...process.env, BUN_BE_BUN: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const request: BundleRequest = { filename, external };
	child.stdin.write(JSON.stringify(request));
	child.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Extension compiler exited with code ${exitCode}: ${stderr.trim()}`);
	const result = JSON.parse(stdout) as BundleResult;
	if (result.status === "failed") return undefined;
	const bundleHash = hash(result.source);
	const code =
		cached?.policy === policy && cached.bundleHash === bundleHash
			? cached.code
			: jiti.transform({
					source: result.source,
					filename,
					async: true,
					ts: false,
				});
	const artifact: Artifact = {
		version,
		policy,
		external,
		observations: result.observations,
		bundleHash,
		codeHash: hash(code),
		code,
	};
	const temporary = `${cachedFile}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(artifact));
	renameSync(temporary, cachedFile);
	return code;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
