// Compile extensions in the binary and validate artifacts against file stamps and compiler versions.
import { build, Transpiler } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Jiti } from "jiti";
import jitiMetadata from "jiti/package.json";
import { VERSION } from "../../src/config.ts";

interface InputStamp {
	filename: string;
	mtimeMs: number;
	size: number;
}

interface Artifact {
	version: string;
	inputs: InputStamp[];
	directories: Array<{ filename: string; mtimeMs: number }>;
	code: string;
}

const version = `precompile-6:${VERSION}:${jitiMetadata.version}:${process.versions.bun}`;

/** Compile an extension without executing its factory, reusing a valid artifact. */
export async function prepareCompiledExtension(
	filename: string,
	virtualModules: Record<string, unknown>,
	jiti: Jiti,
	cacheDirectory: string,
): Promise<string | undefined> {
	mkdirSync(cacheDirectory, { recursive: true });
	const key = createHash("sha256").update(filename).digest("hex");
	const cachedFile = join(cacheDirectory, key + ".json");
	try {
		const cached = JSON.parse(readFileSync(cachedFile, "utf8")) as Artifact;
		if (
			cached.version === version &&
			cached.inputs.every((input) => {
				const stat = statSync(input.filename);
				return stat.mtimeMs === input.mtimeMs && stat.size === input.size;
			}) &&
			cached.directories.every((directory) => statSync(directory.filename).mtimeMs === directory.mtimeMs)
		) {
			return cached.code;
		}
	} catch (error) {
		if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const inputs = new Map<string, InputStamp>();
	const directories = new Map<string, number>();
	const addInput = (path: string) => {
		if (inputs.has(path)) return;
		const stat = statSync(path);
		inputs.set(path, { filename: path, mtimeMs: stat.mtimeMs, size: stat.size });
	};
	const result = await build({
		entrypoints: [filename], target: "node", format: "esm", minify: true, throw: false,
		plugins: [{ name: "extension-paths", setup(builder) {
			builder.onResolve({ filter: /.*/ }, (args) => {
				if (isBuiltin(args.path) || args.path in virtualModules) {
					return { path: args.path, external: true };
				}
				if (args.path.endsWith(".node")) {
					const filename = resolve(args.resolveDir, args.path);
					addInput(filename);
					return { path: filename, external: true };
				}
			});
			builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
				const path = resolve(args.path);
				addInput(path);
				let current = dirname(path);
				while (current !== dirname(current)) {
					if (directories.has(current)) break;
					// Directory stamps detect new files that change resolution precedence.
					directories.set(current, statSync(current).mtimeMs);
					for (const name of ["package.json", "tsconfig.json"]) {
						try { addInput(join(current, name)); }
						catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
					}
					current = dirname(current);
				}
				const extension = extname(path);
				const loader = extension === ".tsx" ? "tsx" : extension === ".jsx" ? "jsx" : /\.[cm]?ts$/.test(path) ? "ts" : "js";
				const transpiler = new Transpiler({ loader, trimUnusedImports: true, define: {
					"import.meta.url": JSON.stringify(pathToFileURL(path).href),
					"import.meta.dirname": JSON.stringify(dirname(path)),
					"import.meta.filename": JSON.stringify(path),
					__dirname: JSON.stringify(dirname(path)),
					__filename: JSON.stringify(path),
				} });
				return { contents: transpiler.transformSync(readFileSync(path, "utf8")), loader: "js" };
			});
			builder.onLoad({ filter: /\.json$/ }, (args) => {
				addInput(resolve(args.path));
				return { contents: readFileSync(args.path, "utf8"), loader: "json" };
			});
		} }],
	});
	if (!result.success) {
		return undefined;
	}
	const output = await result.outputs[0].text();
	const code = jiti.transform({ source: output, filename, async: true, ts: false });
	const artifact: Artifact = {
		version, inputs: [...inputs.values()],
		directories: [...directories].map(([filename, mtimeMs]) => ({ filename, mtimeMs })),
		code,
	};
	const temporary = cachedFile + `.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(artifact));
	renameSync(temporary, cachedFile);
	return code;
}
