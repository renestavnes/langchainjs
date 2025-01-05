import { z } from "zod";
import pRetry from "p-retry";
import { v4 as uuidv4 } from "uuid";
import { isTraceableFunction, } from "langsmith/singletons/traceable";
import { LogStreamCallbackHandler, RunLog, RunLogPatch, isLogStreamHandler, } from "../tracers/log_stream.js";
import { EventStreamCallbackHandler, isStreamEventsHandler, } from "../tracers/event_stream.js";
import { Serializable } from "../load/serializable.js";
import { IterableReadableStream, concat, atee, pipeGeneratorWithSetup, AsyncGeneratorWithSetup, } from "../utils/stream.js";
import { raceWithSignal } from "../utils/signal.js";
import { DEFAULT_RECURSION_LIMIT, ensureConfig, getCallbackManagerForConfig, mergeConfigs, patchConfig, pickRunnableConfigKeys, } from "./config.js";
import { AsyncCaller } from "../utils/async_caller.js";
import { RootListenersTracer } from "../tracers/root_listener.js";
import { _RootEventFilter, isRunnableInterface } from "./utils.js";
import { AsyncLocalStorageProviderSingleton } from "../singletons/index.js";
import { Graph } from "./graph.js";
import { convertToHttpEventStream } from "./wrappers.js";
import { consumeAsyncIterableInContext, consumeIteratorInContext, isAsyncIterable, isIterableIterator, isIterator, } from "./iter.js";
import { _isToolCall, ToolInputParsingException } from "../tools/utils.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _coerceToDict(value, defaultKey) {
    return value &&
        !Array.isArray(value) &&
        // eslint-disable-next-line no-instanceof/no-instanceof
        !(value instanceof Date) &&
        typeof value === "object"
        ? value
        : { [defaultKey]: value };
}
/**
 * A Runnable is a generic unit of work that can be invoked, batched, streamed, and/or
 * transformed.
 */
export class Runnable extends Serializable {
    constructor() {
        super(...arguments);
        Object.defineProperty(this, "lc_runnable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
    }
    getName(suffix) {
        const name = 
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.name ?? this.constructor.lc_name() ?? this.constructor.name;
        return suffix ? `${name}${suffix}` : name;
    }
    /**
     * Bind arguments to a Runnable, returning a new Runnable.
     * @param kwargs
     * @returns A new RunnableBinding that, when invoked, will apply the bound args.
     */
    bind(kwargs) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return new RunnableBinding({ bound: this, kwargs, config: {} });
    }
    /**
     * Return a new Runnable that maps a list of inputs to a list of outputs,
     * by calling invoke() with each input.
     */
    map() {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return new RunnableEach({ bound: this });
    }
    /**
     * Add retry logic to an existing runnable.
     * @param kwargs
     * @returns A new RunnableRetry that, when invoked, will retry according to the parameters.
     */
    withRetry(fields) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return new RunnableRetry({
            bound: this,
            kwargs: {},
            config: {},
            maxAttemptNumber: fields?.stopAfterAttempt,
            ...fields,
        });
    }
    /**
     * Bind config to a Runnable, returning a new Runnable.
     * @param config New configuration parameters to attach to the new runnable.
     * @returns A new RunnableBinding with a config matching what's passed.
     */
    withConfig(config) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return new RunnableBinding({
            bound: this,
            config,
            kwargs: {},
        });
    }
    /**
     * Create a new runnable from the current one that will try invoking
     * other passed fallback runnables if the initial invocation fails.
     * @param fields.fallbacks Other runnables to call if the runnable errors.
     * @returns A new RunnableWithFallbacks.
     */
    withFallbacks(fields) {
        const fallbacks = Array.isArray(fields) ? fields : fields.fallbacks;
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return new RunnableWithFallbacks({
            runnable: this,
            fallbacks,
        });
    }
    _getOptionsList(options, length = 0) {
        if (Array.isArray(options) && options.length !== length) {
            throw new Error(`Passed "options" must be an array with the same length as the inputs, but got ${options.length} options for ${length} inputs`);
        }
        if (Array.isArray(options)) {
            return options.map(ensureConfig);
        }
        if (length > 1 && !Array.isArray(options) && options.runId) {
            console.warn("Provided runId will be used only for the first element of the batch.");
            const subsequent = Object.fromEntries(Object.entries(options).filter(([key]) => key !== "runId"));
            return Array.from({ length }, (_, i) => ensureConfig(i === 0 ? options : subsequent));
        }
        return Array.from({ length }, () => ensureConfig(options));
    }
    async batch(inputs, options, batchOptions) {
        const configList = this._getOptionsList(options ?? {}, inputs.length);
        const maxConcurrency = configList[0]?.maxConcurrency ?? batchOptions?.maxConcurrency;
        const caller = new AsyncCaller({
            maxConcurrency,
            onFailedAttempt: (e) => {
                throw e;
            },
        });
        const batchCalls = inputs.map((input, i) => caller.call(async () => {
            try {
                const result = await this.invoke(input, configList[i]);
                return result;
            }
            catch (e) {
                if (batchOptions?.returnExceptions) {
                    return e;
                }
                throw e;
            }
        }));
        return Promise.all(batchCalls);
    }
    /**
     * Default streaming implementation.
     * Subclasses should override this method if they support streaming output.
     * @param input
     * @param options
     */
    async *_streamIterator(input, options) {
        yield this.invoke(input, options);
    }
    /**
     * Stream output in chunks.
     * @param input
     * @param options
     * @returns A readable stream that is also an iterable.
     */
    async stream(input, options) {
        // Buffer the first streamed chunk to allow for initial errors
        // to surface immediately.
        const config = ensureConfig(options);
        const wrappedGenerator = new AsyncGeneratorWithSetup({
            generator: this._streamIterator(input, config),
            config,
        });
        await wrappedGenerator.setup;
        return IterableReadableStream.fromAsyncGenerator(wrappedGenerator);
    }
    _separateRunnableConfigFromCallOptions(options) {
        let runnableConfig;
        if (options === undefined) {
            runnableConfig = ensureConfig(options);
        }
        else {
            runnableConfig = ensureConfig({
                callbacks: options.callbacks,
                tags: options.tags,
                metadata: options.metadata,
                runName: options.runName,
                configurable: options.configurable,
                recursionLimit: options.recursionLimit,
                maxConcurrency: options.maxConcurrency,
                runId: options.runId,
                timeout: options.timeout,
                signal: options.signal,
            });
        }
        const callOptions = { ...options };
        delete callOptions.callbacks;
        delete callOptions.tags;
        delete callOptions.metadata;
        delete callOptions.runName;
        delete callOptions.configurable;
        delete callOptions.recursionLimit;
        delete callOptions.maxConcurrency;
        delete callOptions.runId;
        delete callOptions.timeout;
        delete callOptions.signal;
        return [runnableConfig, callOptions];
    }
    async _callWithConfig(func, input, options) {
        const config = ensureConfig(options);
        const callbackManager_ = await getCallbackManagerForConfig(config);
        const runManager = await callbackManager_?.handleChainStart(this.toJSON(), _coerceToDict(input, "input"), config.runId, config?.runType, undefined, undefined, config?.runName ?? this.getName());
        delete config.runId;
        let output;
        try {
            const promise = func.call(this, input, config, runManager);
            output = await raceWithSignal(promise, options?.signal);
        }
        catch (e) {
            await runManager?.handleChainError(e);
            throw e;
        }
        await runManager?.handleChainEnd(_coerceToDict(output, "output"));
        return output;
    }
    /**
     * Internal method that handles batching and configuration for a runnable
     * It takes a function, input values, and optional configuration, and
     * returns a promise that resolves to the output values.
     * @param func The function to be executed for each input value.
     * @param input The input values to be processed.
     * @param config Optional configuration for the function execution.
     * @returns A promise that resolves to the output values.
     */
    async _batchWithConfig(func, inputs, options, batchOptions) {
        const optionsList = this._getOptionsList(options ?? {}, inputs.length);
        const callbackManagers = await Promise.all(optionsList.map(getCallbackManagerForConfig));
        const runManagers = await Promise.all(callbackManagers.map(async (callbackManager, i) => {
            const handleStartRes = await callbackManager?.handleChainStart(this.toJSON(), _coerceToDict(inputs[i], "input"), optionsList[i].runId, optionsList[i].runType, undefined, undefined, optionsList[i].runName ?? this.getName());
            delete optionsList[i].runId;
            return handleStartRes;
        }));
        let outputs;
        try {
            const promise = func.call(this, inputs, optionsList, runManagers, batchOptions);
            outputs = await raceWithSignal(promise, optionsList?.[0]?.signal);
        }
        catch (e) {
            await Promise.all(runManagers.map((runManager) => runManager?.handleChainError(e)));
            throw e;
        }
        await Promise.all(runManagers.map((runManager) => runManager?.handleChainEnd(_coerceToDict(outputs, "output"))));
        return outputs;
    }
    /**
     * Helper method to transform an Iterator of Input values into an Iterator of
     * Output values, with callbacks.
     * Use this to implement `stream()` or `transform()` in Runnable subclasses.
     */
    async *_transformStreamWithConfig(inputGenerator, transformer, options) {
        let finalInput;
        let finalInputSupported = true;
        let finalOutput;
        let finalOutputSupported = true;
        const config = ensureConfig(options);
        const callbackManager_ = await getCallbackManagerForConfig(config);
        async function* wrapInputForTracing() {
            for await (const chunk of inputGenerator) {
                if (finalInputSupported) {
                    if (finalInput === undefined) {
                        finalInput = chunk;
                    }
                    else {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            finalInput = concat(finalInput, chunk);
                        }
                        catch {
                            finalInput = undefined;
                            finalInputSupported = false;
                        }
                    }
                }
                yield chunk;
            }
        }
        let runManager;
        try {
            const pipe = await pipeGeneratorWithSetup(transformer.bind(this), wrapInputForTracing(), async () => callbackManager_?.handleChainStart(this.toJSON(), { input: "" }, config.runId, config.runType, undefined, undefined, config.runName ?? this.getName()), options?.signal, config);
            delete config.runId;
            runManager = pipe.setup;
            const streamEventsHandler = runManager?.handlers.find(isStreamEventsHandler);
            let iterator = pipe.output;
            if (streamEventsHandler !== undefined && runManager !== undefined) {
                iterator = streamEventsHandler.tapOutputIterable(runManager.runId, iterator);
            }
            const streamLogHandler = runManager?.handlers.find(isLogStreamHandler);
            if (streamLogHandler !== undefined && runManager !== undefined) {
                iterator = streamLogHandler.tapOutputIterable(runManager.runId, iterator);
            }
            for await (const chunk of iterator) {
                yield chunk;
                if (finalOutputSupported) {
                    if (finalOutput === undefined) {
                        finalOutput = chunk;
                    }
                    else {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            finalOutput = concat(finalOutput, chunk);
                        }
                        catch {
                            finalOutput = undefined;
                            finalOutputSupported = false;
                        }
                    }
                }
            }
        }
        catch (e) {
            await runManager?.handleChainError(e, undefined, undefined, undefined, {
                inputs: _coerceToDict(finalInput, "input"),
            });
            throw e;
        }
        await runManager?.handleChainEnd(finalOutput ?? {}, undefined, undefined, undefined, { inputs: _coerceToDict(finalInput, "input") });
    }
    getGraph(_) {
        const graph = new Graph();
        // TODO: Add input schema for runnables
        const inputNode = graph.addNode({
            name: `${this.getName()}Input`,
            schema: z.any(),
        });
        const runnableNode = graph.addNode(this);
        // TODO: Add output schemas for runnables
        const outputNode = graph.addNode({
            name: `${this.getName()}Output`,
            schema: z.any(),
        });
        graph.addEdge(inputNode, runnableNode);
        graph.addEdge(runnableNode, outputNode);
        return graph;
    }
    /**
     * Create a new runnable sequence that runs each individual runnable in series,
     * piping the output of one runnable into another runnable or runnable-like.
     * @param coerceable A runnable, function, or object whose values are functions or runnables.
     * @returns A new runnable sequence.
     */
    pipe(coerceable) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return new RunnableSequence({
            first: this,
            last: _coerceToRunnable(coerceable),
        });
    }
    /**
     * Pick keys from the dict output of this runnable. Returns a new runnable.
     */
    pick(keys) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return this.pipe(new RunnablePick(keys));
    }
    /**
     * Assigns new fields to the dict output of this runnable. Returns a new runnable.
     */
    assign(mapping) {
        return this.pipe(
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        new RunnableAssign(
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        new RunnableMap({ steps: mapping })));
    }
    /**
     * Default implementation of transform, which buffers input and then calls stream.
     * Subclasses should override this method if they can start producing output while
     * input is still being generated.
     * @param generator
     * @param options
     */
    async *transform(generator, options) {
        let finalChunk;
        for await (const chunk of generator) {
            if (finalChunk === undefined) {
                finalChunk = chunk;
            }
            else {
                // Make a best effort to gather, for any type that supports concat.
                // This method should throw an error if gathering fails.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                finalChunk = concat(finalChunk, chunk);
            }
        }
        yield* this._streamIterator(finalChunk, ensureConfig(options));
    }
    /**
     * Stream all output from a runnable, as reported to the callback system.
     * This includes all inner runs of LLMs, Retrievers, Tools, etc.
     * Output is streamed as Log objects, which include a list of
     * jsonpatch ops that describe how the state of the run has changed in each
     * step, and the final state of the run.
     * The jsonpatch ops can be applied in order to construct state.
     * @param input
     * @param options
     * @param streamOptions
     */
    async *streamLog(input, options, streamOptions) {
        const logStreamCallbackHandler = new LogStreamCallbackHandler({
            ...streamOptions,
            autoClose: false,
            _schemaFormat: "original",
        });
        const config = ensureConfig(options);
        yield* this._streamLog(input, logStreamCallbackHandler, config);
    }
    async *_streamLog(input, logStreamCallbackHandler, config) {
        const { callbacks } = config;
        if (callbacks === undefined) {
            // eslint-disable-next-line no-param-reassign
            config.callbacks = [logStreamCallbackHandler];
        }
        else if (Array.isArray(callbacks)) {
            // eslint-disable-next-line no-param-reassign
            config.callbacks = callbacks.concat([logStreamCallbackHandler]);
        }
        else {
            const copiedCallbacks = callbacks.copy();
            copiedCallbacks.addHandler(logStreamCallbackHandler, true);
            // eslint-disable-next-line no-param-reassign
            config.callbacks = copiedCallbacks;
        }
        const runnableStreamPromise = this.stream(input, config);
        async function consumeRunnableStream() {
            try {
                const runnableStream = await runnableStreamPromise;
                for await (const chunk of runnableStream) {
                    const patch = new RunLogPatch({
                        ops: [
                            {
                                op: "add",
                                path: "/streamed_output/-",
                                value: chunk,
                            },
                        ],
                    });
                    await logStreamCallbackHandler.writer.write(patch);
                }
            }
            finally {
                await logStreamCallbackHandler.writer.close();
            }
        }
        const runnableStreamConsumePromise = consumeRunnableStream();
        try {
            for await (const log of logStreamCallbackHandler) {
                yield log;
            }
        }
        finally {
            await runnableStreamConsumePromise;
        }
    }
    streamEvents(input, options, streamOptions) {
        let stream;
        if (options.version === "v1") {
            stream = this._streamEventsV1(input, options, streamOptions);
        }
        else if (options.version === "v2") {
            stream = this._streamEventsV2(input, options, streamOptions);
        }
        else {
            throw new Error(`Only versions "v1" and "v2" of the schema are currently supported.`);
        }
        if (options.encoding === "text/event-stream") {
            return convertToHttpEventStream(stream);
        }
        else {
            return IterableReadableStream.fromAsyncGenerator(stream);
        }
    }
    async *_streamEventsV2(input, options, streamOptions) {
        const eventStreamer = new EventStreamCallbackHandler({
            ...streamOptions,
            autoClose: false,
        });
        const config = ensureConfig(options);
        const runId = config.runId ?? uuidv4();
        config.runId = runId;
        const callbacks = config.callbacks;
        if (callbacks === undefined) {
            config.callbacks = [eventStreamer];
        }
        else if (Array.isArray(callbacks)) {
            config.callbacks = callbacks.concat(eventStreamer);
        }
        else {
            const copiedCallbacks = callbacks.copy();
            copiedCallbacks.addHandler(eventStreamer, true);
            // eslint-disable-next-line no-param-reassign
            config.callbacks = copiedCallbacks;
        }
        // Call the runnable in streaming mode,
        // add each chunk to the output stream
        const outerThis = this;
        async function consumeRunnableStream() {
            try {
                const runnableStream = await outerThis.stream(input, config);
                const tappedStream = eventStreamer.tapOutputIterable(runId, runnableStream);
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                for await (const _ of tappedStream) {
                    // Just iterate so that the callback handler picks up events
                }
            }
            finally {
                await eventStreamer.finish();
            }
        }
        const runnableStreamConsumePromise = consumeRunnableStream();
        let firstEventSent = false;
        let firstEventRunId;
        try {
            for await (const event of eventStreamer) {
                // This is a work-around an issue where the inputs into the
                // chain are not available until the entire input is consumed.
                // As a temporary solution, we'll modify the input to be the input
                // that was passed into the chain.
                if (!firstEventSent) {
                    event.data.input = input;
                    firstEventSent = true;
                    firstEventRunId = event.run_id;
                    yield event;
                    continue;
                }
                if (event.run_id === firstEventRunId && event.event.endsWith("_end")) {
                    // If it's the end event corresponding to the root runnable
                    // we dont include the input in the event since it's guaranteed
                    // to be included in the first event.
                    if (event.data?.input) {
                        delete event.data.input;
                    }
                }
                yield event;
            }
        }
        finally {
            await runnableStreamConsumePromise;
        }
    }
    async *_streamEventsV1(input, options, streamOptions) {
        let runLog;
        let hasEncounteredStartEvent = false;
        const config = ensureConfig(options);
        const rootTags = config.tags ?? [];
        const rootMetadata = config.metadata ?? {};
        const rootName = config.runName ?? this.getName();
        const logStreamCallbackHandler = new LogStreamCallbackHandler({
            ...streamOptions,
            autoClose: false,
            _schemaFormat: "streaming_events",
        });
        const rootEventFilter = new _RootEventFilter({
            ...streamOptions,
        });
        const logStream = this._streamLog(input, logStreamCallbackHandler, config);
        for await (const log of logStream) {
            if (!runLog) {
                runLog = RunLog.fromRunLogPatch(log);
            }
            else {
                runLog = runLog.concat(log);
            }
            if (runLog.state === undefined) {
                throw new Error(`Internal error: "streamEvents" state is missing. Please open a bug report.`);
            }
            // Yield the start event for the root runnable if it hasn't been seen.
            // The root run is never filtered out
            if (!hasEncounteredStartEvent) {
                hasEncounteredStartEvent = true;
                const state = { ...runLog.state };
                const event = {
                    run_id: state.id,
                    event: `on_${state.type}_start`,
                    name: rootName,
                    tags: rootTags,
                    metadata: rootMetadata,
                    data: {
                        input,
                    },
                };
                if (rootEventFilter.includeEvent(event, state.type)) {
                    yield event;
                }
            }
            const paths = log.ops
                .filter((op) => op.path.startsWith("/logs/"))
                .map((op) => op.path.split("/")[2]);
            const dedupedPaths = [...new Set(paths)];
            for (const path of dedupedPaths) {
                let eventType;
                let data = {};
                const logEntry = runLog.state.logs[path];
                if (logEntry.end_time === undefined) {
                    if (logEntry.streamed_output.length > 0) {
                        eventType = "stream";
                    }
                    else {
                        eventType = "start";
                    }
                }
                else {
                    eventType = "end";
                }
                if (eventType === "start") {
                    // Include the inputs with the start event if they are available.
                    // Usually they will NOT be available for components that operate
                    // on streams, since those components stream the input and
                    // don't know its final value until the end of the stream.
                    if (logEntry.inputs !== undefined) {
                        data.input = logEntry.inputs;
                    }
                }
                else if (eventType === "end") {
                    if (logEntry.inputs !== undefined) {
                        data.input = logEntry.inputs;
                    }
                    data.output = logEntry.final_output;
                }
                else if (eventType === "stream") {
                    const chunkCount = logEntry.streamed_output.length;
                    if (chunkCount !== 1) {
                        throw new Error(`Expected exactly one chunk of streamed output, got ${chunkCount} instead. Encountered in: "${logEntry.name}"`);
                    }
                    data = { chunk: logEntry.streamed_output[0] };
                    // Clean up the stream, we don't need it anymore.
                    // And this avoids duplicates as well!
                    logEntry.streamed_output = [];
                }
                yield {
                    event: `on_${logEntry.type}_${eventType}`,
                    name: logEntry.name,
                    run_id: logEntry.id,
                    tags: logEntry.tags,
                    metadata: logEntry.metadata,
                    data,
                };
            }
            // Finally, we take care of the streaming output from the root chain
            // if there is any.
            const { state } = runLog;
            if (state.streamed_output.length > 0) {
                const chunkCount = state.streamed_output.length;
                if (chunkCount !== 1) {
                    throw new Error(`Expected exactly one chunk of streamed output, got ${chunkCount} instead. Encountered in: "${state.name}"`);
                }
                const data = { chunk: state.streamed_output[0] };
                // Clean up the stream, we don't need it anymore.
                state.streamed_output = [];
                const event = {
                    event: `on_${state.type}_stream`,
                    run_id: state.id,
                    tags: rootTags,
                    metadata: rootMetadata,
                    name: rootName,
                    data,
                };
                if (rootEventFilter.includeEvent(event, state.type)) {
                    yield event;
                }
            }
        }
        const state = runLog?.state;
        if (state !== undefined) {
            // Finally, yield the end event for the root runnable.
            const event = {
                event: `on_${state.type}_end`,
                name: rootName,
                run_id: state.id,
                tags: rootTags,
                metadata: rootMetadata,
                data: {
                    output: state.final_output,
                },
            };
            if (rootEventFilter.includeEvent(event, state.type))
                yield event;
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static isRunnable(thing) {
        return isRunnableInterface(thing);
    }
    /**
     * Bind lifecycle listeners to a Runnable, returning a new Runnable.
     * The Run object contains information about the run, including its id,
     * type, input, output, error, startTime, endTime, and any tags or metadata
     * added to the run.
     *
     * @param {Object} params - The object containing the callback functions.
     * @param {(run: Run) => void} params.onStart - Called before the runnable starts running, with the Run object.
     * @param {(run: Run) => void} params.onEnd - Called after the runnable finishes running, with the Run object.
     * @param {(run: Run) => void} params.onError - Called if the runnable throws an error, with the Run object.
     */
    withListeners({ onStart, onEnd, onError, }) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return new RunnableBinding({
            bound: this,
            config: {},
            configFactories: [
                (config) => ({
                    callbacks: [
                        new RootListenersTracer({
                            config,
                            onStart,
                            onEnd,
                            onError,
                        }),
                    ],
                }),
            ],
        });
    }
    /**
     * Convert a runnable to a tool. Return a new instance of `RunnableToolLike`
     * which contains the runnable, name, description and schema.
     *
     * @template {T extends RunInput = RunInput} RunInput - The input type of the runnable. Should be the same as the `RunInput` type of the runnable.
     *
     * @param fields
     * @param {string | undefined} [fields.name] The name of the tool. If not provided, it will default to the name of the runnable.
     * @param {string | undefined} [fields.description] The description of the tool. Falls back to the description on the Zod schema if not provided, or undefined if neither are provided.
     * @param {z.ZodType<T>} [fields.schema] The Zod schema for the input of the tool. Infers the Zod type from the input type of the runnable.
     * @returns {RunnableToolLike<z.ZodType<T>, RunOutput>} An instance of `RunnableToolLike` which is a runnable that can be used as a tool.
     */
    asTool(fields) {
        return convertRunnableToTool(this, fields);
    }
}
/**
 * A runnable that delegates calls to another runnable with a set of kwargs.
 * @example
 * ```typescript
 * import {
 *   type RunnableConfig,
 *   RunnableLambda,
 * } from "@langchain/core/runnables";
 *
 * const enhanceProfile = (
 *   profile: Record<string, any>,
 *   config?: RunnableConfig
 * ) => {
 *   if (config?.configurable?.role) {
 *     return { ...profile, role: config.configurable.role };
 *   }
 *   return profile;
 * };
 *
 * const runnable = RunnableLambda.from(enhanceProfile);
 *
 * // Bind configuration to the runnable to set the user's role dynamically
 * const adminRunnable = runnable.bind({ configurable: { role: "Admin" } });
 * const userRunnable = runnable.bind({ configurable: { role: "User" } });
 *
 * const result1 = await adminRunnable.invoke({
 *   name: "Alice",
 *   email: "alice@example.com"
 * });
 *
 * // { name: "Alice", email: "alice@example.com", role: "Admin" }
 *
 * const result2 = await userRunnable.invoke({
 *   name: "Bob",
 *   email: "bob@example.com"
 * });
 *
 * // { name: "Bob", email: "bob@example.com", role: "User" }
 * ```
 */
export class RunnableBinding extends Runnable {
    static lc_name() {
        return "RunnableBinding";
    }
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "bound", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "config", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "kwargs", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "configFactories", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.bound = fields.bound;
        this.kwargs = fields.kwargs;
        this.config = fields.config;
        this.configFactories = fields.configFactories;
    }
    getName(suffix) {
        return this.bound.getName(suffix);
    }
    async _mergeConfig(...options) {
        const config = mergeConfigs(this.config, ...options);
        return mergeConfigs(config, ...(this.configFactories
            ? await Promise.all(this.configFactories.map(async (configFactory) => await configFactory(config)))
            : []));
    }
    bind(kwargs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new this.constructor({
            bound: this.bound,
            kwargs: { ...this.kwargs, ...kwargs },
            config: this.config,
        });
    }
    withConfig(config) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new this.constructor({
            bound: this.bound,
            kwargs: this.kwargs,
            config: { ...this.config, ...config },
        });
    }
    withRetry(fields) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new this.constructor({
            bound: this.bound.withRetry(fields),
            kwargs: this.kwargs,
            config: this.config,
        });
    }
    async invoke(input, options) {
        return this.bound.invoke(input, await this._mergeConfig(ensureConfig(options), this.kwargs));
    }
    async batch(inputs, options, batchOptions) {
        const mergedOptions = Array.isArray(options)
            ? await Promise.all(options.map(async (individualOption) => this._mergeConfig(ensureConfig(individualOption), this.kwargs)))
            : await this._mergeConfig(ensureConfig(options), this.kwargs);
        return this.bound.batch(inputs, mergedOptions, batchOptions);
    }
    async *_streamIterator(input, options) {
        yield* this.bound._streamIterator(input, await this._mergeConfig(ensureConfig(options), this.kwargs));
    }
    async stream(input, options) {
        return this.bound.stream(input, await this._mergeConfig(ensureConfig(options), this.kwargs));
    }
    async *transform(generator, options) {
        yield* this.bound.transform(generator, await this._mergeConfig(ensureConfig(options), this.kwargs));
    }
    streamEvents(input, options, streamOptions) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const outerThis = this;
        const generator = async function* () {
            yield* outerThis.bound.streamEvents(input, {
                ...(await outerThis._mergeConfig(ensureConfig(options), outerThis.kwargs)),
                version: options.version,
            }, streamOptions);
        };
        return IterableReadableStream.fromAsyncGenerator(generator());
    }
    static isRunnableBinding(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    thing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) {
        return thing.bound && Runnable.isRunnable(thing.bound);
    }
    /**
     * Bind lifecycle listeners to a Runnable, returning a new Runnable.
     * The Run object contains information about the run, including its id,
     * type, input, output, error, startTime, endTime, and any tags or metadata
     * added to the run.
     *
     * @param {Object} params - The object containing the callback functions.
     * @param {(run: Run) => void} params.onStart - Called before the runnable starts running, with the Run object.
     * @param {(run: Run) => void} params.onEnd - Called after the runnable finishes running, with the Run object.
     * @param {(run: Run) => void} params.onError - Called if the runnable throws an error, with the Run object.
     */
    withListeners({ onStart, onEnd, onError, }) {
        return new RunnableBinding({
            bound: this.bound,
            kwargs: this.kwargs,
            config: this.config,
            configFactories: [
                (config) => ({
                    callbacks: [
                        new RootListenersTracer({
                            config,
                            onStart,
                            onEnd,
                            onError,
                        }),
                    ],
                }),
            ],
        });
    }
}
/**
 * A runnable that delegates calls to another runnable
 * with each element of the input sequence.
 * @example
 * ```typescript
 * import { RunnableEach, RunnableLambda } from "@langchain/core/runnables";
 *
 * const toUpperCase = (input: string): string => input.toUpperCase();
 * const addGreeting = (input: string): string => `Hello, ${input}!`;
 *
 * const upperCaseLambda = RunnableLambda.from(toUpperCase);
 * const greetingLambda = RunnableLambda.from(addGreeting);
 *
 * const chain = new RunnableEach({
 *   bound: upperCaseLambda.pipe(greetingLambda),
 * });
 *
 * const result = await chain.invoke(["alice", "bob", "carol"])
 *
 * // ["Hello, ALICE!", "Hello, BOB!", "Hello, CAROL!"]
 * ```
 */
export class RunnableEach extends Runnable {
    static lc_name() {
        return "RunnableEach";
    }
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        Object.defineProperty(this, "bound", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.bound = fields.bound;
    }
    /**
     * Binds the runnable with the specified arguments.
     * @param kwargs The arguments to bind the runnable with.
     * @returns A new instance of the `RunnableEach` class that is bound with the specified arguments.
     */
    bind(kwargs) {
        return new RunnableEach({
            bound: this.bound.bind(kwargs),
        });
    }
    /**
     * Invokes the runnable with the specified input and configuration.
     * @param input The input to invoke the runnable with.
     * @param config The configuration to invoke the runnable with.
     * @returns A promise that resolves to the output of the runnable.
     */
    async invoke(inputs, config) {
        return this._callWithConfig(this._invoke.bind(this), inputs, config);
    }
    /**
     * A helper method that is used to invoke the runnable with the specified input and configuration.
     * @param input The input to invoke the runnable with.
     * @param config The configuration to invoke the runnable with.
     * @returns A promise that resolves to the output of the runnable.
     */
    async _invoke(inputs, config, runManager) {
        return this.bound.batch(inputs, patchConfig(config, { callbacks: runManager?.getChild() }));
    }
    /**
     * Bind lifecycle listeners to a Runnable, returning a new Runnable.
     * The Run object contains information about the run, including its id,
     * type, input, output, error, startTime, endTime, and any tags or metadata
     * added to the run.
     *
     * @param {Object} params - The object containing the callback functions.
     * @param {(run: Run) => void} params.onStart - Called before the runnable starts running, with the Run object.
     * @param {(run: Run) => void} params.onEnd - Called after the runnable finishes running, with the Run object.
     * @param {(run: Run) => void} params.onError - Called if the runnable throws an error, with the Run object.
     */
    withListeners({ onStart, onEnd, onError, }) {
        return new RunnableEach({
            bound: this.bound.withListeners({ onStart, onEnd, onError }),
        });
    }
}
/**
 * Base class for runnables that can be retried a
 * specified number of times.
 * @example
 * ```typescript
 * import {
 *   RunnableLambda,
 *   RunnableRetry,
 * } from "@langchain/core/runnables";
 *
 * // Simulate an API call that fails
 * const simulateApiCall = (input: string): string => {
 *   console.log(`Attempting API call with input: ${input}`);
 *   throw new Error("API call failed due to network issue");
 * };
 *
 * const apiCallLambda = RunnableLambda.from(simulateApiCall);
 *
 * // Apply retry logic using the .withRetry() method
 * const apiCallWithRetry = apiCallLambda.withRetry({ stopAfterAttempt: 3 });
 *
 * // Alternatively, create a RunnableRetry instance manually
 * const manualRetry = new RunnableRetry({
 *   bound: apiCallLambda,
 *   maxAttemptNumber: 3,
 *   config: {},
 * });
 *
 * // Example invocation using the .withRetry() method
 * const res = await apiCallWithRetry
 *   .invoke("Request 1")
 *   .catch((error) => {
 *     console.error("Failed after multiple retries:", error.message);
 *   });
 *
 * // Example invocation using the manual retry instance
 * const res2 = await manualRetry
 *   .invoke("Request 2")
 *   .catch((error) => {
 *     console.error("Failed after multiple retries:", error.message);
 *   });
 * ```
 */
export class RunnableRetry extends RunnableBinding {
    static lc_name() {
        return "RunnableRetry";
    }
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        Object.defineProperty(this, "maxAttemptNumber", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: 3
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Object.defineProperty(this, "onFailedAttempt", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: () => { }
        });
        this.maxAttemptNumber = fields.maxAttemptNumber ?? this.maxAttemptNumber;
        this.onFailedAttempt = fields.onFailedAttempt ?? this.onFailedAttempt;
    }
    _patchConfigForRetry(attempt, config, runManager) {
        const tag = attempt > 1 ? `retry:attempt:${attempt}` : undefined;
        return patchConfig(config, { callbacks: runManager?.getChild(tag) });
    }
    async _invoke(input, config, runManager) {
        return pRetry((attemptNumber) => super.invoke(input, this._patchConfigForRetry(attemptNumber, config, runManager)), {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onFailedAttempt: (error) => this.onFailedAttempt(error, input),
            retries: Math.max(this.maxAttemptNumber - 1, 0),
            randomize: true,
        });
    }
    /**
     * Method that invokes the runnable with the specified input, run manager,
     * and config. It handles the retry logic by catching any errors and
     * recursively invoking itself with the updated config for the next retry
     * attempt.
     * @param input The input for the runnable.
     * @param runManager The run manager for the runnable.
     * @param config The config for the runnable.
     * @returns A promise that resolves to the output of the runnable.
     */
    async invoke(input, config) {
        return this._callWithConfig(this._invoke.bind(this), input, config);
    }
    async _batch(inputs, configs, runManagers, batchOptions) {
        const resultsMap = {};
        try {
            await pRetry(async (attemptNumber) => {
                const remainingIndexes = inputs
                    .map((_, i) => i)
                    .filter((i) => resultsMap[i.toString()] === undefined ||
                    // eslint-disable-next-line no-instanceof/no-instanceof
                    resultsMap[i.toString()] instanceof Error);
                const remainingInputs = remainingIndexes.map((i) => inputs[i]);
                const patchedConfigs = remainingIndexes.map((i) => this._patchConfigForRetry(attemptNumber, configs?.[i], runManagers?.[i]));
                const results = await super.batch(remainingInputs, patchedConfigs, {
                    ...batchOptions,
                    returnExceptions: true,
                });
                let firstException;
                for (let i = 0; i < results.length; i += 1) {
                    const result = results[i];
                    const resultMapIndex = remainingIndexes[i];
                    // eslint-disable-next-line no-instanceof/no-instanceof
                    if (result instanceof Error) {
                        if (firstException === undefined) {
                            firstException = result;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            firstException.input = remainingInputs[i];
                        }
                    }
                    resultsMap[resultMapIndex.toString()] = result;
                }
                if (firstException) {
                    throw firstException;
                }
                return results;
            }, {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onFailedAttempt: (error) => this.onFailedAttempt(error, error.input),
                retries: Math.max(this.maxAttemptNumber - 1, 0),
                randomize: true,
            });
        }
        catch (e) {
            if (batchOptions?.returnExceptions !== true) {
                throw e;
            }
        }
        return Object.keys(resultsMap)
            .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
            .map((key) => resultsMap[parseInt(key, 10)]);
    }
    async batch(inputs, options, batchOptions) {
        return this._batchWithConfig(this._batch.bind(this), inputs, options, batchOptions);
    }
}
/**
 * A sequence of runnables, where the output of each is the input of the next.
 * @example
 * ```typescript
 * const promptTemplate = PromptTemplate.fromTemplate(
 *   "Tell me a joke about {topic}",
 * );
 * const chain = RunnableSequence.from([promptTemplate, new ChatOpenAI({})]);
 * const result = await chain.invoke({ topic: "bears" });
 * ```
 */
export class RunnableSequence extends Runnable {
    static lc_name() {
        return "RunnableSequence";
    }
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "first", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "middle", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Object.defineProperty(this, "last", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "omitSequenceTags", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        this.first = fields.first;
        this.middle = fields.middle ?? this.middle;
        this.last = fields.last;
        this.name = fields.name;
        this.omitSequenceTags = fields.omitSequenceTags ?? this.omitSequenceTags;
    }
    get steps() {
        return [this.first, ...this.middle, this.last];
    }
    async invoke(input, options) {
        console.log("Invoke called with input:", input);
        console.log("Invoke options:", options);
        const config = ensureConfig(options);
        console.log("Config resolved:", config);
        const callbackManager_ = await getCallbackManagerForConfig(config);
        const runManager = await callbackManager_?.handleChainStart(this.toJSON(), _coerceToDict(input, "input"), config.runId, undefined, undefined, undefined, config?.runName);
        console.log("Run manager initialized:", runManager);
        delete config.runId;
        let nextStepInput = input;
        let finalOutput;
        try {
            const initialSteps = [this.first, ...this.middle];
            console.log("Steps to process:", initialSteps);
            for (let i = 0; i < initialSteps.length; i += 1) {
                const step = initialSteps[i];
                console.log(`Processing step ${i + 1}:`, step);
                const promise = step.invoke(nextStepInput, patchConfig(config, {
                    callbacks: runManager?.getChild(this.omitSequenceTags ? undefined : `seq:step:${i + 1}`),
                }));
                console.log(`Step ${i + 1} input:`, nextStepInput);
                nextStepInput = await raceWithSignal(promise, options?.signal);
                console.log(`Step ${i + 1} output:`, nextStepInput);
            }
            if (options?.signal?.aborted) {
                throw new Error("Aborted");
            }
            console.log("Processing last step:", this.last);
            finalOutput = await this.last.invoke(nextStepInput, patchConfig(config, {
                callbacks: runManager?.getChild(this.omitSequenceTags ? undefined : `seq:step:${this.steps.length}`),
            }));
            console.log("Final output:", finalOutput);
        }
        catch (e) {
            console.error("Error occurred during invoke:", e);
            await runManager?.handleChainError(e);
            throw e;
        }
        console.log("Handle chain end with output:", finalOutput);
        await runManager?.handleChainEnd(_coerceToDict(finalOutput, "output"));
        console.log("Invoke complete.");
        return finalOutput;
    }
    async batch(inputs, options, batchOptions) {
        const configList = this._getOptionsList(options ?? {}, inputs.length);
        const callbackManagers = await Promise.all(configList.map(getCallbackManagerForConfig));
        const runManagers = await Promise.all(callbackManagers.map(async (callbackManager, i) => {
            const handleStartRes = await callbackManager?.handleChainStart(this.toJSON(), _coerceToDict(inputs[i], "input"), configList[i].runId, undefined, undefined, undefined, configList[i].runName);
            delete configList[i].runId;
            return handleStartRes;
        }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let nextStepInputs = inputs;
        try {
            for (let i = 0; i < this.steps.length; i += 1) {
                const step = this.steps[i];
                const promise = step.batch(nextStepInputs, runManagers.map((runManager, j) => {
                    const childRunManager = runManager?.getChild(this.omitSequenceTags ? undefined : `seq:step:${i + 1}`);
                    return patchConfig(configList[j], { callbacks: childRunManager });
                }), batchOptions);
                nextStepInputs = await raceWithSignal(promise, configList[0]?.signal);
            }
        }
        catch (e) {
            await Promise.all(runManagers.map((runManager) => runManager?.handleChainError(e)));
            throw e;
        }
        await Promise.all(runManagers.map((runManager) => runManager?.handleChainEnd(_coerceToDict(nextStepInputs, "output"))));
        return nextStepInputs;
    }
    async *_streamIterator(input, options) {
        const callbackManager_ = await getCallbackManagerForConfig(options);
        const { runId, ...otherOptions } = options ?? {};
        const runManager = await callbackManager_?.handleChainStart(this.toJSON(), _coerceToDict(input, "input"), runId, undefined, undefined, undefined, otherOptions?.runName);
        const steps = [this.first, ...this.middle, this.last];
        let concatSupported = true;
        let finalOutput;
        async function* inputGenerator() {
            yield input;
        }
        try {
            let finalGenerator = steps[0].transform(inputGenerator(), patchConfig(otherOptions, {
                callbacks: runManager?.getChild(this.omitSequenceTags ? undefined : `seq:step:1`),
            }));
            for (let i = 1; i < steps.length; i += 1) {
                const step = steps[i];
                finalGenerator = await step.transform(finalGenerator, patchConfig(otherOptions, {
                    callbacks: runManager?.getChild(this.omitSequenceTags ? undefined : `seq:step:${i + 1}`),
                }));
            }
            for await (const chunk of finalGenerator) {
                options?.signal?.throwIfAborted();
                yield chunk;
                if (concatSupported) {
                    if (finalOutput === undefined) {
                        finalOutput = chunk;
                    }
                    else {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            finalOutput = concat(finalOutput, chunk);
                        }
                        catch (e) {
                            finalOutput = undefined;
                            concatSupported = false;
                        }
                    }
                }
            }
        }
        catch (e) {
            await runManager?.handleChainError(e);
            throw e;
        }
        await runManager?.handleChainEnd(_coerceToDict(finalOutput, "output"));
    }
    getGraph(config) {
        const graph = new Graph();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let currentLastNode = null;
        this.steps.forEach((step, index) => {
            const stepGraph = step.getGraph(config);
            if (index !== 0) {
                stepGraph.trimFirstNode();
            }
            if (index !== this.steps.length - 1) {
                stepGraph.trimLastNode();
            }
            graph.extend(stepGraph);
            const stepFirstNode = stepGraph.firstNode();
            if (!stepFirstNode) {
                throw new Error(`Runnable ${step} has no first node`);
            }
            if (currentLastNode) {
                graph.addEdge(currentLastNode, stepFirstNode);
            }
            currentLastNode = stepGraph.lastNode();
        });
        return graph;
    }
    pipe(coerceable) {
        if (RunnableSequence.isRunnableSequence(coerceable)) {
            return new RunnableSequence({
                first: this.first,
                middle: this.middle.concat([
                    this.last,
                    coerceable.first,
                    ...coerceable.middle,
                ]),
                last: coerceable.last,
                name: this.name ?? coerceable.name,
            });
        }
        else {
            return new RunnableSequence({
                first: this.first,
                middle: [...this.middle, this.last],
                last: _coerceToRunnable(coerceable),
                name: this.name,
            });
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static isRunnableSequence(thing) {
        return Array.isArray(thing.middle) && Runnable.isRunnable(thing);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static from([first, ...runnables], nameOrFields) {
        let extra = {};
        if (typeof nameOrFields === "string") {
            extra.name = nameOrFields;
        }
        else if (nameOrFields !== undefined) {
            extra = nameOrFields;
        }
        return new RunnableSequence({
            ...extra,
            first: _coerceToRunnable(first),
            middle: runnables.slice(0, -1).map(_coerceToRunnable),
            last: _coerceToRunnable(runnables[runnables.length - 1]),
        });
    }
}
/**
 * A runnable that runs a mapping of runnables in parallel,
 * and returns a mapping of their outputs.
 * @example
 * ```typescript
 * const mapChain = RunnableMap.from({
 *   joke: PromptTemplate.fromTemplate("Tell me a joke about {topic}").pipe(
 *     new ChatAnthropic({}),
 *   ),
 *   poem: PromptTemplate.fromTemplate("write a 2-line poem about {topic}").pipe(
 *     new ChatAnthropic({}),
 *   ),
 * });
 * const result = await mapChain.invoke({ topic: "bear" });
 * ```
 */
export class RunnableMap extends Runnable {
    static lc_name() {
        return "RunnableMap";
    }
    getStepsKeys() {
        return Object.keys(this.steps);
    }
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "steps", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.steps = {};
        for (const [key, value] of Object.entries(fields.steps)) {
            this.steps[key] = _coerceToRunnable(value);
        }
    }
    static from(steps) {
        return new RunnableMap({ steps });
    }
    async invoke(input, options) {
        const config = ensureConfig(options);
        const callbackManager_ = await getCallbackManagerForConfig(config);
        const runManager = await callbackManager_?.handleChainStart(this.toJSON(), {
            input,
        }, config.runId, undefined, undefined, undefined, config?.runName);
        delete config.runId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const output = {};
        try {
            const promises = Object.entries(this.steps).map(async ([key, runnable]) => {
                output[key] = await runnable.invoke(input, patchConfig(config, {
                    callbacks: runManager?.getChild(`map:key:${key}`),
                }));
            });
            await raceWithSignal(Promise.all(promises), options?.signal);
        }
        catch (e) {
            await runManager?.handleChainError(e);
            throw e;
        }
        await runManager?.handleChainEnd(output);
        return output;
    }
    async *_transform(generator, runManager, options) {
        // shallow copy steps to ignore changes while iterating
        const steps = { ...this.steps };
        // each step gets a copy of the input iterator
        const inputCopies = atee(generator, Object.keys(steps).length);
        // start the first iteration of each output iterator
        const tasks = new Map(Object.entries(steps).map(([key, runnable], i) => {
            const gen = runnable.transform(inputCopies[i], patchConfig(options, {
                callbacks: runManager?.getChild(`map:key:${key}`),
            }));
            return [key, gen.next().then((result) => ({ key, gen, result }))];
        }));
        // yield chunks as they become available,
        // starting new iterations as needed,
        // until all iterators are done
        while (tasks.size) {
            const promise = Promise.race(tasks.values());
            const { key, result, gen } = await raceWithSignal(promise, options?.signal);
            tasks.delete(key);
            if (!result.done) {
                yield { [key]: result.value };
                tasks.set(key, gen.next().then((result) => ({ key, gen, result })));
            }
        }
    }
    transform(generator, options) {
        return this._transformStreamWithConfig(generator, this._transform.bind(this), options);
    }
    async stream(input, options) {
        async function* generator() {
            yield input;
        }
        const config = ensureConfig(options);
        const wrappedGenerator = new AsyncGeneratorWithSetup({
            generator: this.transform(generator(), config),
            config,
        });
        await wrappedGenerator.setup;
        return IterableReadableStream.fromAsyncGenerator(wrappedGenerator);
    }
}
/**
 * A runnable that wraps a traced LangSmith function.
 */
export class RunnableTraceable extends Runnable {
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: false
        });
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        Object.defineProperty(this, "func", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        if (!isTraceableFunction(fields.func)) {
            throw new Error("RunnableTraceable requires a function that is wrapped in traceable higher-order function");
        }
        this.func = fields.func;
    }
    async invoke(input, options) {
        const [config] = this._getOptionsList(options ?? {}, 1);
        const callbacks = await getCallbackManagerForConfig(config);
        const promise = this.func(patchConfig(config, { callbacks }), input);
        return raceWithSignal(promise, config?.signal);
    }
    async *_streamIterator(input, options) {
        const [config] = this._getOptionsList(options ?? {}, 1);
        const result = await this.invoke(input, options);
        if (isAsyncIterable(result)) {
            for await (const item of result) {
                config?.signal?.throwIfAborted();
                yield item;
            }
            return;
        }
        if (isIterator(result)) {
            while (true) {
                config?.signal?.throwIfAborted();
                const state = result.next();
                if (state.done)
                    break;
                yield state.value;
            }
            return;
        }
        yield result;
    }
    static from(func) {
        return new RunnableTraceable({ func });
    }
}
function assertNonTraceableFunction(func) {
    if (isTraceableFunction(func)) {
        throw new Error("RunnableLambda requires a function that is not wrapped in traceable higher-order function. This shouldn't happen.");
    }
}
/**
 * A runnable that wraps an arbitrary function that takes a single argument.
 * @example
 * ```typescript
 * import { RunnableLambda } from "@langchain/core/runnables";
 *
 * const add = (input: { x: number; y: number }) => input.x + input.y;
 *
 * const multiply = (input: { value: number; multiplier: number }) =>
 *   input.value * input.multiplier;
 *
 * // Create runnables for the functions
 * const addLambda = RunnableLambda.from(add);
 * const multiplyLambda = RunnableLambda.from(multiply);
 *
 * // Chain the lambdas for a mathematical operation
 * const chainedLambda = addLambda.pipe((result) =>
 *   multiplyLambda.invoke({ value: result, multiplier: 2 })
 * );
 *
 * // Example invocation of the chainedLambda
 * const result = await chainedLambda.invoke({ x: 2, y: 3 });
 *
 * // Will log "10" (since (2 + 3) * 2 = 10)
 * ```
 */
export class RunnableLambda extends Runnable {
    static lc_name() {
        return "RunnableLambda";
    }
    constructor(fields) {
        if (isTraceableFunction(fields.func)) {
            // eslint-disable-next-line no-constructor-return
            return RunnableTraceable.from(fields.func);
        }
        super(fields);
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        Object.defineProperty(this, "func", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        assertNonTraceableFunction(fields.func);
        this.func = fields.func;
    }
    static from(func) {
        return new RunnableLambda({
            func,
        });
    }
    async _invoke(input, config, runManager) {
        return new Promise((resolve, reject) => {
            const childConfig = patchConfig(config, {
                callbacks: runManager?.getChild(),
                recursionLimit: (config?.recursionLimit ?? DEFAULT_RECURSION_LIMIT) - 1,
            });
            void AsyncLocalStorageProviderSingleton.runWithConfig(pickRunnableConfigKeys(childConfig), async () => {
                try {
                    let output = await this.func(input, {
                        ...childConfig,
                    });
                    if (output && Runnable.isRunnable(output)) {
                        if (config?.recursionLimit === 0) {
                            throw new Error("Recursion limit reached.");
                        }
                        output = await output.invoke(input, {
                            ...childConfig,
                            recursionLimit: (childConfig.recursionLimit ?? DEFAULT_RECURSION_LIMIT) - 1,
                        });
                    }
                    else if (isAsyncIterable(output)) {
                        let finalOutput;
                        for await (const chunk of consumeAsyncIterableInContext(childConfig, output)) {
                            config?.signal?.throwIfAborted();
                            if (finalOutput === undefined) {
                                finalOutput = chunk;
                            }
                            else {
                                // Make a best effort to gather, for any type that supports concat.
                                try {
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    finalOutput = concat(finalOutput, chunk);
                                }
                                catch (e) {
                                    finalOutput = chunk;
                                }
                            }
                        }
                        output = finalOutput;
                    }
                    else if (isIterableIterator(output)) {
                        let finalOutput;
                        for (const chunk of consumeIteratorInContext(childConfig, output)) {
                            config?.signal?.throwIfAborted();
                            if (finalOutput === undefined) {
                                finalOutput = chunk;
                            }
                            else {
                                // Make a best effort to gather, for any type that supports concat.
                                try {
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    finalOutput = concat(finalOutput, chunk);
                                }
                                catch (e) {
                                    finalOutput = chunk;
                                }
                            }
                        }
                        output = finalOutput;
                    }
                    resolve(output);
                }
                catch (e) {
                    reject(e);
                }
            });
        });
    }
    async invoke(input, options) {
        return this._callWithConfig(this._invoke.bind(this), input, options);
    }
    async *_transform(generator, runManager, config) {
        let finalChunk;
        for await (const chunk of generator) {
            if (finalChunk === undefined) {
                finalChunk = chunk;
            }
            else {
                // Make a best effort to gather, for any type that supports concat.
                try {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    finalChunk = concat(finalChunk, chunk);
                }
                catch (e) {
                    finalChunk = chunk;
                }
            }
        }
        const childConfig = patchConfig(config, {
            callbacks: runManager?.getChild(),
            recursionLimit: (config?.recursionLimit ?? DEFAULT_RECURSION_LIMIT) - 1,
        });
        const output = await new Promise((resolve, reject) => {
            void AsyncLocalStorageProviderSingleton.runWithConfig(pickRunnableConfigKeys(childConfig), async () => {
                try {
                    const res = await this.func(finalChunk, {
                        ...childConfig,
                        config: childConfig,
                    });
                    resolve(res);
                }
                catch (e) {
                    reject(e);
                }
            });
        });
        if (output && Runnable.isRunnable(output)) {
            if (config?.recursionLimit === 0) {
                throw new Error("Recursion limit reached.");
            }
            const stream = await output.stream(finalChunk, childConfig);
            for await (const chunk of stream) {
                yield chunk;
            }
        }
        else if (isAsyncIterable(output)) {
            for await (const chunk of consumeAsyncIterableInContext(childConfig, output)) {
                config?.signal?.throwIfAborted();
                yield chunk;
            }
        }
        else if (isIterableIterator(output)) {
            for (const chunk of consumeIteratorInContext(childConfig, output)) {
                config?.signal?.throwIfAborted();
                yield chunk;
            }
        }
        else {
            yield output;
        }
    }
    transform(generator, options) {
        return this._transformStreamWithConfig(generator, this._transform.bind(this), options);
    }
    async stream(input, options) {
        async function* generator() {
            yield input;
        }
        const config = ensureConfig(options);
        const wrappedGenerator = new AsyncGeneratorWithSetup({
            generator: this.transform(generator(), config),
            config,
        });
        await wrappedGenerator.setup;
        return IterableReadableStream.fromAsyncGenerator(wrappedGenerator);
    }
}
/**
 * A runnable that runs a mapping of runnables in parallel,
 * and returns a mapping of their outputs.
 * @example
 * ```typescript
 * import {
 *   RunnableLambda,
 *   RunnableParallel,
 * } from "@langchain/core/runnables";
 *
 * const addYears = (age: number): number => age + 5;
 * const yearsToFifty = (age: number): number => 50 - age;
 * const yearsToHundred = (age: number): number => 100 - age;
 *
 * const addYearsLambda = RunnableLambda.from(addYears);
 * const milestoneFiftyLambda = RunnableLambda.from(yearsToFifty);
 * const milestoneHundredLambda = RunnableLambda.from(yearsToHundred);
 *
 * // Pipe will coerce objects into RunnableParallel by default, but we
 * // explicitly instantiate one here to demonstrate
 * const sequence = addYearsLambda.pipe(
 *   RunnableParallel.from({
 *     years_to_fifty: milestoneFiftyLambda,
 *     years_to_hundred: milestoneHundredLambda,
 *   })
 * );
 *
 * // Invoke the sequence with a single age input
 * const res = sequence.invoke(25);
 *
 * // { years_to_fifty: 25, years_to_hundred: 75 }
 * ```
 */
export class RunnableParallel extends RunnableMap {
}
/**
 * A Runnable that can fallback to other Runnables if it fails.
 * External APIs (e.g., APIs for a language model) may at times experience
 * degraded performance or even downtime.
 *
 * In these cases, it can be useful to have a fallback Runnable that can be
 * used in place of the original Runnable (e.g., fallback to another LLM provider).
 *
 * Fallbacks can be defined at the level of a single Runnable, or at the level
 * of a chain of Runnables. Fallbacks are tried in order until one succeeds or
 * all fail.
 *
 * While you can instantiate a `RunnableWithFallbacks` directly, it is usually
 * more convenient to use the `withFallbacks` method on an existing Runnable.
 *
 * When streaming, fallbacks will only be called on failures during the initial
 * stream creation. Errors that occur after a stream starts will not fallback
 * to the next Runnable.
 *
 * @example
 * ```typescript
 * import {
 *   RunnableLambda,
 *   RunnableWithFallbacks,
 * } from "@langchain/core/runnables";
 *
 * const primaryOperation = (input: string): string => {
 *   if (input !== "safe") {
 *     throw new Error("Primary operation failed due to unsafe input");
 *   }
 *   return `Processed: ${input}`;
 * };
 *
 * // Define a fallback operation that processes the input differently
 * const fallbackOperation = (input: string): string =>
 *   `Fallback processed: ${input}`;
 *
 * const primaryRunnable = RunnableLambda.from(primaryOperation);
 * const fallbackRunnable = RunnableLambda.from(fallbackOperation);
 *
 * // Apply the fallback logic using the .withFallbacks() method
 * const runnableWithFallback = primaryRunnable.withFallbacks([fallbackRunnable]);
 *
 * // Alternatively, create a RunnableWithFallbacks instance manually
 * const manualFallbackChain = new RunnableWithFallbacks({
 *   runnable: primaryRunnable,
 *   fallbacks: [fallbackRunnable],
 * });
 *
 * // Example invocation using .withFallbacks()
 * const res = await runnableWithFallback
 *   .invoke("unsafe input")
 *   .catch((error) => {
 *     console.error("Failed after all attempts:", error.message);
 *   });
 *
 * // "Fallback processed: unsafe input"
 *
 * // Example invocation using manual instantiation
 * const res = await manualFallbackChain
 *   .invoke("safe")
 *   .catch((error) => {
 *     console.error("Failed after all attempts:", error.message);
 *   });
 *
 * // "Processed: safe"
 * ```
 */
export class RunnableWithFallbacks extends Runnable {
    static lc_name() {
        return "RunnableWithFallbacks";
    }
    constructor(fields) {
        super(fields);
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "runnable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "fallbacks", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.runnable = fields.runnable;
        this.fallbacks = fields.fallbacks;
    }
    *runnables() {
        yield this.runnable;
        for (const fallback of this.fallbacks) {
            yield fallback;
        }
    }
    async invoke(input, options) {
        const config = ensureConfig(options);
        const callbackManager_ = await getCallbackManagerForConfig(config);
        const { runId, ...otherConfigFields } = config;
        const runManager = await callbackManager_?.handleChainStart(this.toJSON(), _coerceToDict(input, "input"), runId, undefined, undefined, undefined, otherConfigFields?.runName);
        const childConfig = patchConfig(otherConfigFields, {
            callbacks: runManager?.getChild(),
        });
        const res = await AsyncLocalStorageProviderSingleton.runWithConfig(childConfig, async () => {
            let firstError;
            for (const runnable of this.runnables()) {
                config?.signal?.throwIfAborted();
                try {
                    const output = await runnable.invoke(input, childConfig);
                    await runManager?.handleChainEnd(_coerceToDict(output, "output"));
                    return output;
                }
                catch (e) {
                    if (firstError === undefined) {
                        firstError = e;
                    }
                }
            }
            if (firstError === undefined) {
                throw new Error("No error stored at end of fallback.");
            }
            await runManager?.handleChainError(firstError);
            throw firstError;
        });
        return res;
    }
    async *_streamIterator(input, options) {
        const config = ensureConfig(options);
        const callbackManager_ = await getCallbackManagerForConfig(config);
        const { runId, ...otherConfigFields } = config;
        const runManager = await callbackManager_?.handleChainStart(this.toJSON(), _coerceToDict(input, "input"), runId, undefined, undefined, undefined, otherConfigFields?.runName);
        let firstError;
        let stream;
        for (const runnable of this.runnables()) {
            config?.signal?.throwIfAborted();
            const childConfig = patchConfig(otherConfigFields, {
                callbacks: runManager?.getChild(),
            });
            try {
                const originalStream = await runnable.stream(input, childConfig);
                stream = consumeAsyncIterableInContext(childConfig, originalStream);
                break;
            }
            catch (e) {
                if (firstError === undefined) {
                    firstError = e;
                }
            }
        }
        if (stream === undefined) {
            const error = firstError ?? new Error("No error stored at end of fallback.");
            await runManager?.handleChainError(error);
            throw error;
        }
        let output;
        try {
            for await (const chunk of stream) {
                yield chunk;
                try {
                    output = output === undefined ? output : concat(output, chunk);
                }
                catch (e) {
                    output = undefined;
                }
            }
        }
        catch (e) {
            await runManager?.handleChainError(e);
            throw e;
        }
        await runManager?.handleChainEnd(_coerceToDict(output, "output"));
    }
    async batch(inputs, options, batchOptions) {
        if (batchOptions?.returnExceptions) {
            throw new Error("Not implemented.");
        }
        const configList = this._getOptionsList(options ?? {}, inputs.length);
        const callbackManagers = await Promise.all(configList.map((config) => getCallbackManagerForConfig(config)));
        const runManagers = await Promise.all(callbackManagers.map(async (callbackManager, i) => {
            const handleStartRes = await callbackManager?.handleChainStart(this.toJSON(), _coerceToDict(inputs[i], "input"), configList[i].runId, undefined, undefined, undefined, configList[i].runName);
            delete configList[i].runId;
            return handleStartRes;
        }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let firstError;
        for (const runnable of this.runnables()) {
            configList[0].signal?.throwIfAborted();
            try {
                const outputs = await runnable.batch(inputs, runManagers.map((runManager, j) => patchConfig(configList[j], {
                    callbacks: runManager?.getChild(),
                })), batchOptions);
                await Promise.all(runManagers.map((runManager, i) => runManager?.handleChainEnd(_coerceToDict(outputs[i], "output"))));
                return outputs;
            }
            catch (e) {
                if (firstError === undefined) {
                    firstError = e;
                }
            }
        }
        if (!firstError) {
            throw new Error("No error stored at end of fallbacks.");
        }
        await Promise.all(runManagers.map((runManager) => runManager?.handleChainError(firstError)));
        throw firstError;
    }
}
// TODO: Figure out why the compiler needs help eliminating Error as a RunOutput type
export function _coerceToRunnable(coerceable) {
    if (typeof coerceable === "function") {
        return new RunnableLambda({ func: coerceable });
    }
    else if (Runnable.isRunnable(coerceable)) {
        return coerceable;
    }
    else if (!Array.isArray(coerceable) && typeof coerceable === "object") {
        const runnables = {};
        for (const [key, value] of Object.entries(coerceable)) {
            runnables[key] = _coerceToRunnable(value);
        }
        return new RunnableMap({
            steps: runnables,
        });
    }
    else {
        throw new Error(`Expected a Runnable, function or object.\nInstead got an unsupported type.`);
    }
}
/**
 * A runnable that assigns key-value pairs to inputs of type `Record<string, unknown>`.
 * @example
 * ```typescript
 * import {
 *   RunnableAssign,
 *   RunnableLambda,
 *   RunnableParallel,
 * } from "@langchain/core/runnables";
 *
 * const calculateAge = (x: { birthYear: number }): { age: number } => {
 *   const currentYear = new Date().getFullYear();
 *   return { age: currentYear - x.birthYear };
 * };
 *
 * const createGreeting = (x: { name: string }): { greeting: string } => {
 *   return { greeting: `Hello, ${x.name}!` };
 * };
 *
 * const mapper = RunnableParallel.from({
 *   age_step: RunnableLambda.from(calculateAge),
 *   greeting_step: RunnableLambda.from(createGreeting),
 * });
 *
 * const runnableAssign = new RunnableAssign({ mapper });
 *
 * const res = await runnableAssign.invoke({ name: "Alice", birthYear: 1990 });
 *
 * // { name: "Alice", birthYear: 1990, age_step: { age: 34 }, greeting_step: { greeting: "Hello, Alice!" } }
 * ```
 */
export class RunnableAssign extends Runnable {
    static lc_name() {
        return "RunnableAssign";
    }
    constructor(fields) {
        // eslint-disable-next-line no-instanceof/no-instanceof
        if (fields instanceof RunnableMap) {
            // eslint-disable-next-line no-param-reassign
            fields = { mapper: fields };
        }
        super(fields);
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "mapper", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.mapper = fields.mapper;
    }
    async invoke(input, options) {
        const mapperResult = await this.mapper.invoke(input, options);
        return {
            ...input,
            ...mapperResult,
        };
    }
    async *_transform(generator, runManager, options) {
        // collect mapper keys
        const mapperKeys = this.mapper.getStepsKeys();
        // create two input gens, one for the mapper, one for the input
        const [forPassthrough, forMapper] = atee(generator);
        // create mapper output gen
        const mapperOutput = this.mapper.transform(forMapper, patchConfig(options, { callbacks: runManager?.getChild() }));
        // start the mapper
        const firstMapperChunkPromise = mapperOutput.next();
        // yield the passthrough
        for await (const chunk of forPassthrough) {
            if (typeof chunk !== "object" || Array.isArray(chunk)) {
                throw new Error(`RunnableAssign can only be used with objects as input, got ${typeof chunk}`);
            }
            const filtered = Object.fromEntries(Object.entries(chunk).filter(([key]) => !mapperKeys.includes(key)));
            if (Object.keys(filtered).length > 0) {
                yield filtered;
            }
        }
        // yield the mapper output
        yield (await firstMapperChunkPromise).value;
        for await (const chunk of mapperOutput) {
            yield chunk;
        }
    }
    transform(generator, options) {
        return this._transformStreamWithConfig(generator, this._transform.bind(this), options);
    }
    async stream(input, options) {
        async function* generator() {
            yield input;
        }
        const config = ensureConfig(options);
        const wrappedGenerator = new AsyncGeneratorWithSetup({
            generator: this.transform(generator(), config),
            config,
        });
        await wrappedGenerator.setup;
        return IterableReadableStream.fromAsyncGenerator(wrappedGenerator);
    }
}
/**
 * A runnable that assigns key-value pairs to inputs of type `Record<string, unknown>`.
 * Useful for streaming, can be automatically created and chained by calling `runnable.pick();`.
 * @example
 * ```typescript
 * import { RunnablePick } from "@langchain/core/runnables";
 *
 * const inputData = {
 *   name: "John",
 *   age: 30,
 *   city: "New York",
 *   country: "USA",
 *   email: "john.doe@example.com",
 *   phone: "+1234567890",
 * };
 *
 * const basicInfoRunnable = new RunnablePick(["name", "city"]);
 *
 * // Example invocation
 * const res = await basicInfoRunnable.invoke(inputData);
 *
 * // { name: 'John', city: 'New York' }
 * ```
 */
export class RunnablePick extends Runnable {
    static lc_name() {
        return "RunnablePick";
    }
    constructor(fields) {
        if (typeof fields === "string" || Array.isArray(fields)) {
            // eslint-disable-next-line no-param-reassign
            fields = { keys: fields };
        }
        super(fields);
        Object.defineProperty(this, "lc_namespace", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ["langchain_core", "runnables"]
        });
        Object.defineProperty(this, "lc_serializable", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: true
        });
        Object.defineProperty(this, "keys", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.keys = fields.keys;
    }
    async _pick(input) {
        if (typeof this.keys === "string") {
            return input[this.keys];
        }
        else {
            const picked = this.keys
                .map((key) => [key, input[key]])
                .filter((v) => v[1] !== undefined);
            return picked.length === 0 ? undefined : Object.fromEntries(picked);
        }
    }
    async invoke(input, options) {
        return this._callWithConfig(this._pick.bind(this), input, options);
    }
    async *_transform(generator) {
        for await (const chunk of generator) {
            const picked = await this._pick(chunk);
            if (picked !== undefined) {
                yield picked;
            }
        }
    }
    transform(generator, options) {
        return this._transformStreamWithConfig(generator, this._transform.bind(this), options);
    }
    async stream(input, options) {
        async function* generator() {
            yield input;
        }
        const config = ensureConfig(options);
        const wrappedGenerator = new AsyncGeneratorWithSetup({
            generator: this.transform(generator(), config),
            config,
        });
        await wrappedGenerator.setup;
        return IterableReadableStream.fromAsyncGenerator(wrappedGenerator);
    }
}
export class RunnableToolLike extends RunnableBinding {
    constructor(fields) {
        const sequence = RunnableSequence.from([
            RunnableLambda.from(async (input) => {
                let toolInput;
                if (_isToolCall(input)) {
                    try {
                        toolInput = await this.schema.parseAsync(input.args);
                    }
                    catch (e) {
                        throw new ToolInputParsingException(`Received tool input did not match expected schema`, JSON.stringify(input.args));
                    }
                }
                else {
                    toolInput = input;
                }
                return toolInput;
            }).withConfig({ runName: `${fields.name}:parse_input` }),
            fields.bound,
        ]).withConfig({ runName: fields.name });
        super({
            bound: sequence,
            config: fields.config ?? {},
        });
        Object.defineProperty(this, "name", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "description", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "schema", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.name = fields.name;
        this.description = fields.description;
        this.schema = fields.schema;
    }
    static lc_name() {
        return "RunnableToolLike";
    }
}
/**
 * Given a runnable and a Zod schema, convert the runnable to a tool.
 *
 * @template RunInput The input type for the runnable.
 * @template RunOutput The output type for the runnable.
 *
 * @param {Runnable<RunInput, RunOutput>} runnable The runnable to convert to a tool.
 * @param fields
 * @param {string | undefined} [fields.name] The name of the tool. If not provided, it will default to the name of the runnable.
 * @param {string | undefined} [fields.description] The description of the tool. Falls back to the description on the Zod schema if not provided, or undefined if neither are provided.
 * @param {z.ZodType<RunInput>} [fields.schema] The Zod schema for the input of the tool. Infers the Zod type from the input type of the runnable.
 * @returns {RunnableToolLike<z.ZodType<RunInput>, RunOutput>} An instance of `RunnableToolLike` which is a runnable that can be used as a tool.
 */
export function convertRunnableToTool(runnable, fields) {
    const name = fields.name ?? runnable.getName();
    const description = fields.description ?? fields.schema?.description;
    if (fields.schema.constructor === z.ZodString) {
        return new RunnableToolLike({
            name,
            description,
            schema: z
                .object({
                input: z.string(),
            })
                .transform((input) => input.input),
            bound: runnable,
        });
    }
    return new RunnableToolLike({
        name,
        description,
        schema: fields.schema,
        bound: runnable,
    });
}
