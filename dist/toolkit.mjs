import { err } from "./result.mjs";
import { asGenerator } from "./stream.mjs";
import { z } from "zod/v4";
//#region packages/core/src/toolkit.ts
/**
* @module
* Tool definition, composition, and execution.
*
* @example
* ```ts
* import { tool, merge } from "@ronde/core/toolkit";
*
* const weather = tool({
*   name: "weather",
*   description: "Get weather for a city",
*   parameters: z.object({ city: z.string() }),
*   execute: async (args) => ok({ temp: 22 }),
*   format: (data) => `${data.temp}°C`,
* });
* ```
*/
const runtimeFactorySymbol = Symbol("ronde.toolkitRuntimeFactory");
/**
* Bind a toolkit to a fresh runtime instance. Toolkits created by `tool()`
* and `merge()` expose an internal runtime factory so each engine execution
* gets isolated stateful tool cells. Hand-built toolkits fall back to
* themselves and remain responsible for any lifecycle they implement.
*/
function bindToolkitRuntime(toolkit) {
	const bind = toolkit[runtimeFactorySymbol];
	const bound = bind ? bind() : toolkit;
	if (!bound.dispose) return bound;
	const inner = bound.dispose;
	let disposed = false;
	return {
		...bound,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await inner();
		}
	};
}
/** Default formatter: returns error string, passes through strings, JSON.stringify for objects. */
function defaultFormatter(_toolName, output) {
	if (!output.ok) return output.error;
	const { data } = output;
	if (typeof data === "string") return data;
	if (data == null) return "";
	return JSON.stringify(data);
}
/** Resolve the formatted string for a tool output, falling back to `defaultFormatter`. */
function formatToolOutput(toolkit, toolName, output) {
	const formatter = toolkit.formatters[toolName];
	if (!formatter) return defaultFormatter(toolName, output);
	if (output.ok) return formatter(output.data);
	if (output.data === void 0) return output.error;
	return `${output.error}\n${formatter(output.data)}`;
}
function tool(defOrNothing) {
	if (defOrNothing === void 0) return (def) => _tool(def);
	return _tool(defOrNothing);
}
function _tool(def) {
	const jsonSchema = z.toJSONSchema(def.parameters, { unrepresentable: "any" });
	const schema = {
		name: def.name,
		description: def.description,
		inputSchema: jsonSchema,
		strict: def.strict
	};
	const formatters = def.format ? { [def.name]: def.format } : {};
	const createRuntime = () => createSingleToolRuntime(def, schema, formatters);
	let directRuntime;
	const getDirectRuntime = () => directRuntime ??= createRuntime();
	return {
		schemas: [schema],
		execute: (name, args, ctx) => getDirectRuntime().execute(name, args, ctx),
		formatters,
		dispose: async () => {
			if (!directRuntime) return;
			try {
				await directRuntime.dispose?.();
			} finally {
				directRuntime = void 0;
			}
		},
		[runtimeFactorySymbol]: createRuntime
	};
}
function merge(...toolkits) {
	const formatters = {};
	const schemaMap = /* @__PURE__ */ new Map();
	for (const tk of toolkits) {
		for (const schema of tk.schemas) schemaMap.set(schema.name, schema);
		Object.assign(formatters, tk.formatters);
	}
	const createRuntime = () => {
		const runtimeChildren = toolkits.map((tk) => bindToolkitRuntime(tk));
		const runtimeRouting = /* @__PURE__ */ new Map();
		for (const tk of runtimeChildren) for (const schema of tk.schemas) runtimeRouting.set(schema.name, tk);
		const execute = (name, args, ctx) => {
			const tk = runtimeRouting.get(name);
			if (!tk) return Promise.resolve(err(`Unknown tool '${name}'`));
			return tk.execute(name, args, ctx);
		};
		const disposables = runtimeChildren.filter((tk) => tk.dispose);
		const dispose = disposables.length > 0 ? async () => {
			for (const tk of disposables) try {
				await tk.dispose();
			} catch {}
		} : void 0;
		return {
			schemas: [...schemaMap.values()],
			execute,
			formatters,
			dispose
		};
	};
	let directRuntime;
	const getDirectRuntime = () => directRuntime ??= createRuntime();
	return {
		schemas: [...schemaMap.values()],
		execute: (name, args, ctx) => getDirectRuntime().execute(name, args, ctx),
		formatters,
		dispose: async () => {
			if (!directRuntime) return;
			try {
				await directRuntime.dispose?.();
			} finally {
				directRuntime = void 0;
			}
		},
		[runtimeFactorySymbol]: createRuntime
	};
}
function createSingleToolRuntime(def, schema, formatters) {
	let slot = { status: "cold" };
	async function ensureState() {
		if (!def.state) return;
		while (true) switch (slot.status) {
			case "ready": return slot.state;
			case "initializing": return await slot.promise;
			case "disposed": throw new Error(`Tool "${def.name}" executed after the engine has completed`);
			case "cold": {
				const promise = (async () => {
					const state = await def.state.init();
					slot = {
						status: "ready",
						state
					};
					return state;
				})().catch((error) => {
					if (slot.status === "initializing" && slot.promise === promise) slot = { status: "cold" };
					throw error;
				});
				slot = {
					status: "initializing",
					promise
				};
				return await promise;
			}
		}
	}
	const executeIsGenerator = isAsyncGeneratorFunction(def.execute);
	const execute = (name, rawArgs, baseCtx) => {
		if (name !== def.name) return Promise.resolve(err(`Tool '${name}' not found in this toolkit`));
		const parsed = def.parameters.safeParse(rawArgs);
		if (!parsed.success) return Promise.resolve(err(`Invalid arguments for ${def.name}: ${parsed.error.message}`));
		if (!def.state) return def.execute(parsed.data, baseCtx);
		if (executeIsGenerator) return wrapStatefulGenerator(def.execute, parsed.data, baseCtx, ensureState);
		return wrapStatefulPromise(def.execute, parsed.data, baseCtx, ensureState);
	};
	const dispose = def.state ? async () => {
		if (slot.status === "disposed" || slot.status === "cold") {
			slot = { status: "disposed" };
			return;
		}
		if (slot.status === "initializing") try {
			await slot.promise;
		} catch {
			slot = { status: "disposed" };
			return;
		}
		if (slot.status === "ready") try {
			await def.state.dispose?.(slot.state);
		} catch {}
		slot = { status: "disposed" };
	} : void 0;
	return {
		schemas: [schema],
		execute,
		formatters,
		dispose
	};
}
const AsyncGeneratorFunction = async function* () {}.constructor;
function isAsyncGeneratorFunction(fn) {
	if (typeof fn !== "function") return false;
	return Object.prototype.toString.call(fn) === "[object AsyncGeneratorFunction]" || fn instanceof AsyncGeneratorFunction;
}
async function* wrapStatefulGenerator(exec, args, baseCtx, ensureState) {
	const state = await ensureState();
	return yield* asGenerator(exec(args, {
		...baseCtx,
		state
	}));
}
async function wrapStatefulPromise(exec, args, baseCtx, ensureState) {
	const state = await ensureState();
	return await exec(args, {
		...baseCtx,
		state
	});
}
//#endregion
export { bindToolkitRuntime, defaultFormatter, formatToolOutput, merge, tool };

//# sourceMappingURL=toolkit.mjs.map