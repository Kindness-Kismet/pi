// Exercise extension cache validity through evaluated module behavior.
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";
import { prepareCompiledExtension } from "./extension-cache.ts";

const fixtureRoot = fileURLToPath(new URL("../../../../build/cold-start/cache-tests/", import.meta.url));
mkdirSync(fixtureRoot, { recursive: true });

function createFixture(source = 'export default () => "first";') {
	const root = mkdtempSync(join(fixtureRoot, "case-"));
	const agent = join(root, "agent");
	const extensions = join(agent, "extensions");
	mkdirSync(extensions, { recursive: true });
	const entry = join(extensions, "entry.ts");
	writeFileSync(entry, source);
	const compiler = createJiti(import.meta.url, {
		fsCache: false,
		moduleCache: false,
	});
	const transform = compiler.transform;
	let compilations = 0;
	compiler.transform = (options) => {
		compilations++;
		return transform(options);
	};
	const cache = join(agent, "cache");
	const compile = (virtualModules: Record<string, unknown> = {}) =>
		prepareCompiledExtension(entry, virtualModules, compiler, cache);
	const evaluate = async (virtualModules: Record<string, unknown> = {}) => {
		const code = await compile(virtualModules);
		expect(code).toBeDefined();
		if (code === undefined) throw new Error("The fixture extension failed to compile");
		const loader = createJiti(import.meta.url, {
			fsCache: false,
			moduleCache: false,
			virtualModules,
			tryNative: false,
			transform: (options) => ({ code: options.source }),
		});
		const loaded = (await loader.evalModule(code, {
			filename: entry,
			ext: ".cjs",
			async: true,
			forceTranspile: true,
		})) as { default: () => unknown };
		return loaded.default();
	};
	return {
		agent,
		extensions,
		entry,
		cache,
		compiler,
		compile,
		evaluate,
		compilations: () => compilations,
	};
}

function writePackage(base: string, name: string, value: string, main = "index.js") {
	const directory = join(base, "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ main }));
	writeFileSync(join(directory, main), main.endsWith(".json") ? JSON.stringify(value) : `export default "${value}";`);
	return directory;
}

describe("extension precompile cache", () => {
	test("reuses code when ancestor runtime state changes", async () => {
		const fixture = createFixture();
		expect(await fixture.evaluate()).toBe("first");
		writeFileSync(join(fixture.agent, "session-state.json"), "{}");
		expect(await fixture.evaluate()).toBe("first");
		expect(fixture.compilations()).toBe(1);
	});

	test("reuses code after touching an unchanged input", async () => {
		const fixture = createFixture();
		const first = await fixture.compile();
		const before = statSync(fixture.entry);
		utimesSync(fixture.entry, before.atime, new Date(before.mtimeMs + 1000));
		expect(await fixture.compile()).toBe(first);
		expect(fixture.compilations()).toBe(1);
	});

	test("loads new source content with identical size and restored mtime", async () => {
		const fixture = createFixture();
		expect(await fixture.evaluate()).toBe("first");
		const before = statSync(fixture.entry);
		writeFileSync(fixture.entry, 'export default () => "other";');
		utimesSync(fixture.entry, before.atime, before.mtime);
		expect(statSync(fixture.entry).size).toBe(before.size);
		expect(await fixture.evaluate()).toBe("other");
		expect(fixture.compilations()).toBe(2);
	});

	test("reuses code when a source directory gains an unrelated log", async () => {
		const fixture = createFixture();
		const first = await fixture.compile();
		writeFileSync(join(fixture.extensions, "debug.log"), "debug");
		expect(await fixture.compile()).toBe(first);
		expect(fixture.compilations()).toBe(1);
	});

	test("reuses code when package description changes", async () => {
		const fixture = createFixture();
		const metadata = join(fixture.agent, "package.json");
		writeFileSync(metadata, '{"type":"module","description":"first"}');
		const first = await fixture.compile();
		writeFileSync(metadata, '{"type":"module","description":"other"}');
		expect(await fixture.compile()).toBe(first);
		expect(fixture.compilations()).toBe(1);
	});

	test("reuses code when an unreferenced package is installed", async () => {
		const fixture = createFixture('import value from "fixture-value"; export default () => value;');
		writePackage(fixture.agent, "fixture-value", "first");
		expect(await fixture.evaluate()).toBe("first");
		writePackage(fixture.agent, "unused-package", "unused");
		expect(await fixture.evaluate()).toBe("first");
		expect(fixture.compilations()).toBe(1);
	});

	test("changes behavior when an import becomes virtual", async () => {
		const fixture = createFixture('import value from "fixture-value"; export default () => value;');
		writePackage(fixture.agent, "fixture-value", "first");
		expect(await fixture.evaluate()).toBe("first");
		expect(await fixture.evaluate({ "fixture-value": { default: "virtual" } })).toBe("virtual");
		expect(await fixture.evaluate({ "fixture-value": { default: "updated" } })).toBe("updated");
		expect(fixture.compilations()).toBe(2);
		expect(await fixture.evaluate()).toBe("first");
		expect(fixture.compilations()).toBe(3);
	});

	test("reuses code when an external native binary changes", async () => {
		const fixture = createFixture(
			'export default () => "first"; export async function native() { return import("./addon.node"); }',
		);
		const addon = join(fixture.extensions, "addon.node");
		writeFileSync(addon, "first");
		const first = await fixture.compile();
		writeFileSync(addon, "second");
		expect(await fixture.compile()).toBe(first);
		expect(fixture.compilations()).toBe(1);
	});

	test("loads a JSON-only package's changed main entry", async () => {
		const fixture = createFixture('import value from "fixture-value"; export default () => value;');
		const pkg = writePackage(fixture.agent, "fixture-value", "first", "first.json");
		writeFileSync(join(pkg, "other.json"), '"other"');
		expect(await fixture.evaluate()).toBe("first");
		writeFileSync(join(pkg, "package.json"), '{"main":"other.json"}');
		expect(await fixture.evaluate()).toBe("other");
		expect(fixture.compilations()).toBe(2);
	});

	test("uses a nearer package in the same process", async () => {
		const fixture = createFixture('import value from "fixture-value"; export default () => value;');
		writePackage(fixture.agent, "fixture-value", "first");
		expect(await fixture.evaluate()).toBe("first");
		writePackage(fixture.extensions, "fixture-value", "nearer");
		expect(await fixture.evaluate()).toBe("nearer");
		expect(await fixture.evaluate()).toBe("nearer");
		expect(fixture.compilations()).toBe(2);
	});

	test("tracks tsconfig extends content changes", async () => {
		const fixture = createFixture('import value from "fixture-alias"; export default () => value;');
		const base = join(fixture.agent, "base.json");
		writeFileSync(join(fixture.agent, "tsconfig.json"), '{"extends":"./base.json"}');
		writeFileSync(join(fixture.agent, "first.ts"), 'export default "first";');
		writeFileSync(join(fixture.agent, "other.ts"), 'export default "other";');
		writeFileSync(base, '{"compilerOptions":{"baseUrl":".","paths":{"fixture-alias":["./first.ts"]}}}');
		expect(await fixture.evaluate()).toBe("first");
		const before = statSync(base);
		writeFileSync(base, '{"compilerOptions":{"baseUrl":".","paths":{"fixture-alias":["./other.ts"]}}}');
		utimesSync(base, before.atime, before.mtime);
		expect(await fixture.evaluate()).toBe("other");
		expect(fixture.compilations()).toBe(2);
	});

	test("uses a newly added earlier tsconfig path candidate", async () => {
		const fixture = createFixture('import value from "fixture-alias"; export default () => value;');
		writeFileSync(
			join(fixture.agent, "tsconfig.json"),
			'{"compilerOptions":{"baseUrl":".","paths":{"fixture-alias":["./earlier/value","./later/value"]}}}',
		);
		mkdirSync(join(fixture.agent, "later"));
		writeFileSync(join(fixture.agent, "later", "value.ts"), 'export default "later";');
		expect(await fixture.evaluate()).toBe("later");
		mkdirSync(join(fixture.agent, "earlier"));
		writeFileSync(join(fixture.agent, "earlier", "value.ts"), 'export default "earlier";');
		expect(await fixture.evaluate()).toBe("earlier");
	});

	test("tracks a tsconfig inherited from an npm package", async () => {
		const fixture = createFixture('import value from "fixture-alias"; export default () => value;');
		const pkg = join(fixture.agent, "node_modules", "fixture-config");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), '{"main":"tsconfig.json"}');
		writeFileSync(
			join(pkg, "tsconfig.json"),
			'{"compilerOptions":{"baseUrl":"../../","paths":{"fixture-alias":["./first.ts"]}}}',
		);
		writeFileSync(
			join(fixture.agent, "tsconfig.json"),
			'{"extends":"./node_modules/fixture-config/tsconfig.json","compilerOptions":{"baseUrl":"."}}',
		);
		writeFileSync(join(fixture.agent, "first.ts"), 'export default "first";');
		writeFileSync(join(fixture.agent, "other.ts"), 'export default "other";');
		expect(await fixture.evaluate()).toBe("first");
		writeFileSync(
			join(pkg, "tsconfig.json"),
			'{"compilerOptions":{"baseUrl":"../../","paths":{"fixture-alias":["./other.ts"]}}}',
		);
		expect(await fixture.evaluate()).toBe("other");
	});

	test("uses a newly added source extension with higher priority", async () => {
		const fixture = createFixture('import value from "./value"; export default () => value;');
		writeFileSync(join(fixture.extensions, "value.js"), 'export default "first";');
		expect(await fixture.evaluate()).toBe("first");
		writeFileSync(join(fixture.extensions, "value.ts"), 'export default "other";');
		expect(await fixture.evaluate()).toBe("other");
		expect(fixture.compilations()).toBe(2);
	});

	test("follows changed package exports", async () => {
		const fixture = createFixture('import value from "fixture-value"; export default () => value;');
		const pkg = writePackage(fixture.agent, "fixture-value", "first");
		writeFileSync(join(pkg, "other.js"), 'export default "other";');
		writeFileSync(join(pkg, "package.json"), '{"exports":"./index.js"}');
		expect(await fixture.evaluate()).toBe("first");
		writeFileSync(join(pkg, "package.json"), '{"exports":"./other.js"}');
		expect(await fixture.evaluate()).toBe("other");
	});

	test("follows changed package imports", async () => {
		const fixture = createFixture('import value from "#value"; export default () => value;');
		writeFileSync(join(fixture.extensions, "first.ts"), 'export default "first";');
		writeFileSync(join(fixture.extensions, "other.ts"), 'export default "other";');
		const metadata = join(fixture.extensions, "package.json");
		writeFileSync(metadata, '{"imports":{"#value":"./first.ts"}}');
		expect(await fixture.evaluate()).toBe("first");
		writeFileSync(metadata, '{"imports":{"#value":"./other.ts"}}');
		expect(await fixture.evaluate()).toBe("other");
	});

	test("loads changed bundled dependency content", async () => {
		const fixture = createFixture('import value from "fixture-value"; export default () => value;');
		const pkg = writePackage(fixture.agent, "fixture-value", "first");
		expect(await fixture.evaluate()).toBe("first");
		writeFileSync(join(pkg, "index.js"), 'export default "other";');
		expect(await fixture.evaluate()).toBe("other");
	});

	test("does not retain old code after a dependency disappears", async () => {
		const fixture = createFixture('import value from "./value"; export default () => value;');
		const dependency = join(fixture.extensions, "value.ts");
		writeFileSync(dependency, 'export default "first";');
		expect(await fixture.evaluate()).toBe("first");
		renameSync(dependency, `${dependency}.disabled`);
		expect(await fixture.compile()).toBeUndefined();
	});

	test("preserves original import.meta paths", async () => {
		const fixture = createFixture("export default () => import.meta.filename;");
		expect(await fixture.evaluate()).toBe(fixture.entry);
	});

	test("reuses transformed code when new metadata has no effect on output", async () => {
		const fixture = createFixture();
		const first = await fixture.compile();
		writeFileSync(join(fixture.agent, "package.json"), '{"type":"module"}');
		writeFileSync(join(fixture.agent, "tsconfig.json"), '{"compilerOptions":{}}');
		expect(await fixture.compile()).toBe(first);
		expect(fixture.compilations()).toBe(1);
	});

	test("changes transformation when jiti options change", async () => {
		const fixture = createFixture();
		await fixture.compile();
		fixture.compiler.options.sourceMaps = true;
		await fixture.compile();
		expect(fixture.compilations()).toBe(2);
	});

	test("rebuilds malformed or corrupted persisted code", async () => {
		const fixture = createFixture();
		expect(await fixture.evaluate()).toBe("first");
		const cacheFile = join(
			fixture.cache,
			readdirSync(fixture.cache, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".json"))[0],
		);
		const artifact = JSON.parse(readFileSync(cacheFile, "utf8")) as {
			code: string;
		};
		artifact.code = "corrupted";
		writeFileSync(cacheFile, JSON.stringify(artifact));
		expect(await fixture.evaluate()).toBe("first");
		writeFileSync(cacheFile, "{");
		expect(await fixture.evaluate()).toBe("first");
		writeFileSync(cacheFile, "null");
		expect(await fixture.evaluate()).toBe("first");
		expect(fixture.compilations()).toBe(4);
	});

	test("follows package directory symlink replacement", async () => {
		const fixture = createFixture('import value from "fixture-value"; export default () => value;');
		const first = writePackage(join(fixture.agent, "first"), "fixture-value", "first");
		const other = writePackage(join(fixture.agent, "other"), "fixture-value", "other");
		const modules = join(fixture.agent, "node_modules");
		mkdirSync(modules);
		const link = join(modules, "fixture-value");
		symlinkSync(first, link, "junction");
		expect(await fixture.evaluate()).toBe("first");
		renameSync(link, `${link}.old`);
		symlinkSync(other, link, "junction");
		expect(await fixture.evaluate()).toBe("other");
	});

	test("keeps an older binary's cache in a separate location", async () => {
		const fixture = createFixture();
		mkdirSync(fixture.cache, { recursive: true });
		const legacyFile = join(fixture.cache, "legacy.json");
		writeFileSync(legacyFile, "legacy artifact");
		expect(await fixture.evaluate()).toBe("first");
		expect(readFileSync(legacyFile, "utf8")).toBe("legacy artifact");
		expect(readdirSync(fixture.cache, { withFileTypes: true }).filter((entry) => entry.isDirectory())).toHaveLength(
			1,
		);
		expect(await fixture.evaluate()).toBe("first");
		expect(fixture.compilations()).toBe(1);
	});
});
