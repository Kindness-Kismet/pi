// Build the current branch's experimental binary with automatic extension precompilation.
import { build } from "bun";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const packageRoot = join(root, "packages/coding-agent");
const assetDirectory = process.argv[2];
if (!assetDirectory) throw new Error("Provide the current npm pi package directory to copy binary assets");
const output = join(root, "build/startup-precompile/binaries");
await mkdir(output, { recursive: true });
const outfile = join(output, "pi-precompiled.exe");
const compilerPath = fileURLToPath(new URL("./extension-cache.ts", import.meta.url));
const result = await build({
	entrypoints: [
		join(packageRoot, "src/cli.ts"),
		join(packageRoot, "src/utils/image-resize-worker.ts"),
		join(packageRoot, "src/extensions/codemode/worker.ts"),
	],
	root: packageRoot,
	target: "bun",
	compile: {
		target: "bun-windows-x64-baseline",
		outfile,
		executablePath: process.execPath,
		autoloadDotenv: false,
		autoloadBunfig: false,
		autoloadPackageJson: true,
	},
	plugins: [{
		name: "startup-precompile",
		setup(builder) {
			builder.onLoad({ filter: /[\\/]core[\\/]extensions[\\/]loader\.ts$/ }, async (args) => {
				let source = await readFile(args.path, "utf8");
				source = `import { prepareCompiledExtension } from ${JSON.stringify(compilerPath)};\n` + source;
				source = source.replace(
					"const jiti = createJitiImpl(import.meta.url, {",
					'const compilerJiti = createJitiImpl(import.meta.url, { moduleCache: false, fsCache: false, ...resolutionOptions });\n\tconst compiled = await prepareCompiledExtension(canonicalizePath(extensionPath), resolutionOptions.virtualModules ?? {}, compilerJiti, path.join(getAgentDir(), "cache", "extensions-prototype"));\n\tconst jiti = createJitiImpl(import.meta.url, {',
				);
				source = source.replace(
					"moduleCache: false,\n\t\t...resolutionOptions,",
					"moduleCache: false,\n\t\t...resolutionOptions,\n\t\t...(compiled ? { fsCache: false, transform: (options: { source: string }) => ({ code: options.source }) } : {}),",
				);
				source = source.replace(
					'const module = await jiti.import(canonicalizePath(extensionPath), { default: true });',
					'const loadedModule = compiled ? await jiti.evalModule(compiled, { filename: canonicalizePath(extensionPath), ext: ".cjs", async: true, forceTranspile: true }) : await jiti.import(canonicalizePath(extensionPath), { default: true });\n\tconst module = (loadedModule as { default?: unknown } | undefined)?.default ?? loadedModule;',
				);
				if (!source.includes("const compiled = await prepareCompiledExtension(") || !source.includes("const loadedModule = compiled ?")) {
					throw new Error("Extension loader structure changed; update the experimental build injection points");
				}
				source += `
/** Precompile installed entries without executing extension factories. */
export async function precompileInstalledExtensions(paths: Array<string | undefined>): Promise<void> {
	const pending = paths.filter((filename): filename is string => filename !== undefined);
	const seen = new Set<string>();
	const files: string[] = [];
	while (pending.length) {
		const filename = canonicalizePath(pending.pop()!);
		if (seen.has(filename)) continue;
		seen.add(filename);
		if (!fs.existsSync(filename)) continue;
		if (fs.statSync(filename).isDirectory()) {
			pending.push(...(resolveExtensionEntries(filename) ?? discoverExtensionsInDir(filename)));
		} else files.push(filename);
	}
	if (files.length === 0) return;
	const createJitiImpl = await getCreateJiti();
	const virtualModules = await getVirtualModules();
	const compiler = createJitiImpl(import.meta.url, { virtualModules, tryNative: false, moduleCache: false, fsCache: false });
	for (const filename of files) await prepareCompiledExtension(filename, virtualModules, compiler, path.join(getAgentDir(), "cache", "extensions-prototype"));
}
`;
				return { contents: source, loader: "ts", resolveDir: dirname(args.path) };
			});
			builder.onLoad({ filter: /[\\/]core[\\/]package-manager\.ts$/ }, async (args) => {
				let source = await readFile(args.path, "utf8");
				source = 'import { precompileInstalledExtensions } from "./extensions/loader.ts";\n' + source;
				const installEnd = '\t\t\tthrow new Error(`Unsupported install source: ${source}`);\n\t\t});\n\t}';
				if (!source.includes(installEnd)) throw new Error("Package installer structure changed");
				source = source.replace(installEnd, '\t\t\tthrow new Error(`Unsupported install source: ${source}`);\n\t\t});\n\t\tawait precompileInstalledExtensions([this.getInstalledPath(source, scope)]);\n\t}');
				const updateEnd = '\t\tawait this.updateConfiguredSources(updateSources);';
				if (!source.includes(updateEnd)) throw new Error("Package updater structure changed");
				source = source.replace(updateEnd, updateEnd + '\n\t\tawait precompileInstalledExtensions(updateSources.map(entry => this.getInstalledPath(entry.source, entry.scope)));');
				return { contents: source, loader: "ts", resolveDir: dirname(args.path) };
			});
		},
	}],
});
if (!result.success) throw new AggregateError(result.logs, "Experimental binary build failed");
for (const name of ["assets", "theme", "export-html", "native", "photon_rs_bg.wasm", "README.md"]) {
	await cp(join(resolve(assetDirectory), name), join(output, name), { recursive: true });
}
await cp(join(packageRoot, "package.json"), join(output, "package.json"));
const binary = await readFile(outfile);
const manifest = { outfile, bytes: binary.length, sha256: createHash("sha256").update(binary).digest("hex") };
await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));
