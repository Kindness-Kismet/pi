// Describe the filesystem identities that can change extension bundle resolution.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { JSONC } from "bun";

export interface Observation {
	kind: "input" | "package" | "directory" | "config";
	filename: string;
	value: string;
}

export interface BundleRequest {
	filename: string;
	external: string[];
}

export type BundleResult =
	| { status: "built"; source: string; observations: Observation[] }
	| { status: "failed"; reason: string };

/** Compare content and resolution candidates without relying on modification times. */
export function readObservation(observation: Pick<Observation, "filename" | "kind">, inputContents?: Buffer): string {
	try {
		const realpath = realpathSync.native(observation.filename);
		if (observation.kind === "directory") {
			const names = readdirSync(observation.filename, { withFileTypes: true })
				.filter(
					(entry) =>
						entry.isDirectory() ||
						entry.isSymbolicLink() ||
						/\.(?:[cm]?[jt]sx?|json|node|wasm|toml|css|txt)$/i.test(entry.name),
				)
				.map((entry) => entry.name)
				.sort();
			return JSON.stringify([realpath, names]);
		}
		let contents = inputContents ?? readFileSync(observation.filename);
		if (observation.kind === "package") {
			const metadata = JSONC.parse(contents.toString("utf8")) as Record<string, unknown>;
			const resolution = Object.fromEntries(
				["name", "main", "module", "type", "exports", "imports", "browser", "sideEffects", "tsconfig"].map(
					(key) => [key, metadata[key]],
				),
			);
			contents = Buffer.from(JSON.stringify(resolution));
		}
		return `${realpath}:${createHash("sha256").update(contents).digest("hex")}`;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return "missing";
		throw error;
	}
}
