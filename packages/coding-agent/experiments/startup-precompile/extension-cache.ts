// Cache transformed extension bundles by content and compiler policy.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, spawn } from "bun";
import type { Jiti } from "jiti";
import jitiMetadata from "jiti/package.json" with { type: "json" };
import { time } from "../../src/core/timings.ts";
import { type BundleRequest, type BundleResult, type Observation, readObservation } from "./extension-observations.ts";
import { installEpoch, isPackagedBundle } from "./installed-extensions.ts";

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
	installRoot?: string,
): Promise<string | undefined> {
	// Separate compiler generations so another installed binary cannot replace this cache.
	const generationDirectory = join(cacheDirectory, hash(version));
	mkdirSync(generationDirectory, { recursive: true });
	const cachedFile = join(generationDirectory, `${hash(filename)}.json`);
	time(`${filename} prepare cache`, "extensions");
	const external = Object.keys(virtualModules).sort();
	const policy = JSON.stringify({
		transformOptions: jiti.options.transformOptions,
		jsx: jiti.options.jsx,
		interopDefault: jiti.options.interopDefault,
		sourceMaps: jiti.options.sourceMaps,
	});
	const epoch = installRoot && installEpoch(cacheDirectory, installRoot);
	const installedFile =
		installRoot && epoch && !epoch.startsWith("changing:")
			? join(
					generationDirectory,
					`${hash(JSON.stringify(["installed-v2", filename, installRoot, policy, external]))}.installed`,
				)
			: undefined;
	if (installedFile) {
		try {
			const snapshot = JSON.parse(readFileSync(installedFile, "utf8"));
			if (
				snapshot?.epoch === epoch &&
				typeof snapshot.code === "string" &&
				snapshot.digest === hash(snapshot.code)
			) {
				time(`${filename} load installed bundle`, "extensions");
				return snapshot.code;
			}
		} catch (error) {
			if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const saveInstalled = (artifact: Artifact) => {
		if (
			installedFile &&
			installRoot &&
			isPackagedBundle(artifact.observations, installRoot) &&
			installEpoch(cacheDirectory, installRoot) === epoch
		) {
			writeArtifact(installedFile, { epoch, digest: artifact.codeHash, code: artifact.code });
		}
	};
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
				(await observationsMatch(cached.observations))
			) {
				time(`${filename} validate cache (hit)`, "extensions");
				saveInstalled(cached);
				return cached.code;
			}
		}
	} catch (error) {
		if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	// Bun's resolver cache is shared across builds and Workers; a process owns a fresh resolver.
	time(`${filename} validate cache (miss)`, "extensions");
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
	time(`${filename} rebuild bundle`, "extensions");
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
	writeArtifact(cachedFile, artifact);
	saveInstalled(artifact);
	time(`${filename} transform and store cache`, "extensions");
	return code;
}

function writeArtifact(filename: string, artifact: object): void {
	const temporary = `${filename}.${randomUUID()}.tmp`;
	writeFileSync(temporary, JSON.stringify(artifact));
	renameSync(temporary, filename);
}

async function observationsMatch(observations: Observation[]): Promise<boolean> {
	const inputs: Observation[] = [];
	for (const observation of observations) {
		if (observation.kind === "input") {
			inputs.push(observation);
			continue;
		}
		if (observation.value === "missing") {
			try {
				const stat = statSync(observation.filename, { throwIfNoEntry: false });
				if (!stat || (observation.kind === "directory" && !stat.isDirectory())) continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
				throw error;
			}
		}
		if (readObservation(observation) !== observation.value) return false;
	}

	// Overlap cold disk reads while bounding open files and memory on large extensions.
	let next = 0;
	let matching = true;
	async function checkInputs(): Promise<void> {
		while (matching && next < inputs.length) {
			const { filename, value } = inputs[next++];
			try {
				const resolved = await realpath(filename);
				if (!value.startsWith(`${resolved}:`) || `${resolved}:${hash(await readFile(resolved))}` !== value) {
					matching = false;
				}
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EISDIR") throw error;
				matching = false;
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(inputs.length, 16) }, checkInputs));
	return matching;
}

function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
