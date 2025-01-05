"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerConfigureHook = exports._getConfigureHooks = exports.getContextVariable = exports.setContextVariable = void 0;
const run_trees_1 = require("langsmith/run_trees");
const globals_js_1 = require("./globals.cjs");
/**
 * Set a context variable. Context variables are scoped to any
 * child runnables called by the current runnable, or globally if set outside
 * of any runnable.
 *
 * @remarks
 * This function is only supported in environments that support AsyncLocalStorage,
 * including Node.js, Deno, and Cloudflare Workers.
 *
 * @example
 * ```ts
 * import { RunnableLambda } from "@langchain/core/runnables";
 * import {
 *   getContextVariable,
 *   setContextVariable
 * } from "@langchain/core/context";
 *
 * const nested = RunnableLambda.from(() => {
 *   // "bar" because it was set by a parent
 *   console.log(getContextVariable("foo"));
 *
 *   // Override to "baz", but only for child runnables
 *   setContextVariable("foo", "baz");
 *
 *   // Now "baz", but only for child runnables
 *   return getContextVariable("foo");
 * });
 *
 * const runnable = RunnableLambda.from(async () => {
 *   // Set a context variable named "foo"
 *   setContextVariable("foo", "bar");
 *
 *   const res = await nested.invoke({});
 *
 *   // Still "bar" since child changes do not affect parents
 *   console.log(getContextVariable("foo"));
 *
 *   return res;
 * });
 *
 * // undefined, because context variable has not been set yet
 * console.log(getContextVariable("foo"));
 *
 * // Final return value is "baz"
 * const result = await runnable.invoke({});
 * ```
 *
 * @param name The name of the context variable.
 * @param value The value to set.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setContextVariable(name, value) {
    // Avoid using global singleton due to circuluar dependency issues
    const asyncLocalStorageInstance = (0, globals_js_1.getGlobalAsyncLocalStorageInstance)();
    if (asyncLocalStorageInstance === undefined) {
        throw new Error(`Internal error: Global shared async local storage instance has not been initialized.`);
    }
    const runTree = asyncLocalStorageInstance.getStore();
    const contextVars = { ...runTree?.[globals_js_1._CONTEXT_VARIABLES_KEY] };
    contextVars[name] = value;
    let newValue = {};
    if ((0, run_trees_1.isRunTree)(runTree)) {
        newValue = new run_trees_1.RunTree(runTree);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    newValue[globals_js_1._CONTEXT_VARIABLES_KEY] = contextVars;
    asyncLocalStorageInstance.enterWith(newValue);
}
exports.setContextVariable = setContextVariable;
/**
 * Get the value of a previously set context variable. Context variables
 * are scoped to any child runnables called by the current runnable,
 * or globally if set outside of any runnable.
 *
 * @remarks
 * This function is only supported in environments that support AsyncLocalStorage,
 * including Node.js, Deno, and Cloudflare Workers.
 *
 * @example
 * ```ts
 * import { RunnableLambda } from "@langchain/core/runnables";
 * import {
 *   getContextVariable,
 *   setContextVariable
 * } from "@langchain/core/context";
 *
 * const nested = RunnableLambda.from(() => {
 *   // "bar" because it was set by a parent
 *   console.log(getContextVariable("foo"));
 *
 *   // Override to "baz", but only for child runnables
 *   setContextVariable("foo", "baz");
 *
 *   // Now "baz", but only for child runnables
 *   return getContextVariable("foo");
 * });
 *
 * const runnable = RunnableLambda.from(async () => {
 *   // Set a context variable named "foo"
 *   setContextVariable("foo", "bar");
 *
 *   const res = await nested.invoke({});
 *
 *   // Still "bar" since child changes do not affect parents
 *   console.log(getContextVariable("foo"));
 *
 *   return res;
 * });
 *
 * // undefined, because context variable has not been set yet
 * console.log(getContextVariable("foo"));
 *
 * // Final return value is "baz"
 * const result = await runnable.invoke({});
 * ```
 *
 * @param name The name of the context variable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getContextVariable(name) {
    // Avoid using global singleton due to circuluar dependency issues
    const asyncLocalStorageInstance = (0, globals_js_1.getGlobalAsyncLocalStorageInstance)();
    if (asyncLocalStorageInstance === undefined) {
        return undefined;
    }
    const runTree = asyncLocalStorageInstance.getStore();
    return runTree?.[globals_js_1._CONTEXT_VARIABLES_KEY]?.[name];
}
exports.getContextVariable = getContextVariable;
const LC_CONFIGURE_HOOKS_KEY = Symbol("lc:configure_hooks");
const _getConfigureHooks = () => getContextVariable(LC_CONFIGURE_HOOKS_KEY) || [];
exports._getConfigureHooks = _getConfigureHooks;
/**
 * Register a callback configure hook to automatically add callback handlers to all runs.
 *
 * There are two ways to use this:
 *
 * 1. Using a context variable:
 *    - Set `contextVar` to specify the variable name
 *    - Use `setContextVariable()` to store your handler instance
 *
 * 2. Using an environment variable:
 *    - Set both `envVar` and `handlerClass`
 *    - The handler will be instantiated when the env var is set to "true".
 *
 * @example
 * ```typescript
 * // Method 1: Using context variable
 * import {
 *   registerConfigureHook,
 *   setContextVariable
 * } from "@langchain/core/context";
 *
 * const tracer = new MyCallbackHandler();
 * registerConfigureHook({
 *   contextVar: "my_tracer",
 * });
 * setContextVariable("my_tracer", tracer);
 *
 * // ...run code here
 *
 * // Method 2: Using environment variable
 * registerConfigureHook({
 *   handlerClass: MyCallbackHandler,
 *   envVar: "MY_TRACER_ENABLED",
 * });
 * process.env.MY_TRACER_ENABLED = "true";
 *
 * // ...run code here
 * ```
 *
 * @param config Configuration object for the hook
 * @param config.contextVar Name of the context variable containing the handler instance
 * @param config.inheritable Whether child runs should inherit this handler
 * @param config.handlerClass Optional callback handler class (required if using envVar)
 * @param config.envVar Optional environment variable name to control handler activation
 */
const registerConfigureHook = (config) => {
    if (config.envVar && !config.handlerClass) {
        throw new Error("If envVar is set, handlerClass must also be set to a non-None value.");
    }
    setContextVariable(LC_CONFIGURE_HOOKS_KEY, [...(0, exports._getConfigureHooks)(), config]);
};
exports.registerConfigureHook = registerConfigureHook;
