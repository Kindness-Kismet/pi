// Scope installed bundles to package-manager operations and the active resource selection.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import lockfile from "proper-lockfile";
import type { Observation } from "./extension-observations.ts";

interface PackageMetadata {
	precompileRoot?: string;
}

const selected = new AsyncLocalStorage<ReadonlyMap<string, PackageMetadata>>();

export function withInstalledExtensions<T>(metadata: ReadonlyMap<string, PackageMetadata>, load: () => T): T {
	return selected.run(metadata, load);
}

export function selectedInstallRoot(filename: string): string | undefined {
	return selected.getStore()?.get(filename)?.precompileRoot;
}

function epochFile(cache: string, root: string): string {
	return join(cache, "installs", createHash("sha256").update(root).digest("hex"));
}

export function installEpoch(cache: string, root: string): string {
	try {
		return readFileSync(epochFile(cache, root), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "initial";
		throw error;
	}
}

export async function changeInstallation(cache: string, root: string, operation: () => Promise<void>): Promise<void> {
	const file = epochFile(cache, root);
	mkdirSync(dirname(file), { recursive: true });
	const id = randomUUID();
	const publish = (value: string) => {
		const temporary = `${file}.${id}`;
		writeFileSync(temporary, value);
		renameSync(temporary, file);
	};
	const release = await lockfile.lock(file, { realpath: false, retries: { retries: 60, maxTimeout: 1000 } });
	try {
		publish(`changing:${id}`);
		await operation();
		// Failed or interrupted operations keep the strict source checks until a successful retry.
		publish(id);
	} finally {
		await release();
	}
}

export function isPackagedBundle(observations: Observation[], root: string): boolean {
	for (const item of observations) {
		if (item.kind === "directory" && item.value !== "missing") {
			const path = relative(root, item.filename);
			if (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path)) {
				const [resolved] = JSON.parse(item.value) as [string, string[]];
				if (relative(item.filename, resolved) !== "") return false;
			}
		}
		if (item.kind !== "input" && item.kind !== "config") continue;
		if (item.value === "missing") continue;
		const path = relative(root, item.filename);
		if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return false;
		// A linked source or config remains editable in its original location.
		if (!item.value.startsWith(`${item.filename}:`)) return false;
	}
	return true;
}
