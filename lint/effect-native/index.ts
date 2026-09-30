import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

// The Effect-native constructs oxlint's built-in rules cannot express (it
// has no `no-restricted-syntax`). Globals and properties (`Date`, `fetch`,
// timers, `JSON.*`, `console`, `process.env`, `Math.random`, `Promise.*`)
// are banned with `no-restricted-globals` and `no-restricted-properties` in
// `oxlint.config.ts`.

type AnyFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

/** `async` functions and arrows, `await` and `for await`. */
const noAsyncRule = defineRule({
  createOnce(context) {
    const checkFunction = (node: AnyFunction) => {
      if (node.async) {
        context.report({ messageId: "async", node });
      }
    };
    return {
      ArrowFunctionExpression: checkFunction,
      AwaitExpression(node) {
        context.report({ messageId: "await", node });
      },
      ForOfStatement(node) {
        if (node.await) {
          context.report({ messageId: "await", node });
        }
      },
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
    };
  },
  meta: {
    docs: { description: "Disallow async/await; use Effect.gen." },
    messages: {
      async:
        "No async functions: use Effect.gen, and Effect.tryPromise at a promise boundary.",
      await:
        "No await: yield* an Effect inside Effect.gen (Effect.tryPromise wraps a promise).",
    },
    type: "problem",
  },
});

const promiseMethods = new Set(["catch", "finally", "then"]);

/**
 * `new Promise(...)` and `.then()` / `.catch()` / `.finally()` calls. There
 * is no type information, so a method call counts unless its receiver is a
 * PascalCase identifier: a module namespace such as `Effect.catch(...)`.
 */
const noPromiseRule = defineRule({
  createOnce(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !promiseMethods.has(callee.property.name) ||
          (callee.object.type === "Identifier" &&
            /^[A-Z]/u.test(callee.object.name))
        ) {
          return;
        }
        context.report({
          data: { method: callee.property.name },
          messageId: "chain",
          node,
        });
      },
      NewExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "Promise"
        ) {
          context.report({ messageId: "construct", node });
        }
      },
    };
  },
  meta: {
    docs: { description: "Disallow promise construction and chaining." },
    messages: {
      chain:
        "No .{{ method }}() promise chaining: use Effect.gen, Effect.catch or Effect.ensuring, with Effect.tryPromise at the boundary.",
      construct:
        "No new Promise: use Effect.callback, or Effect.tryPromise at the boundary.",
    },
    type: "problem",
  },
});

/** `try` statements. */
const noTryRule = defineRule({
  createOnce(context) {
    return {
      TryStatement(node) {
        context.report({ messageId: "try", node });
      },
    };
  },
  meta: {
    docs: { description: "Disallow try/catch; use Effect.try." },
    messages: {
      try: "No try/catch: use Effect.try (or Effect.tryPromise) with a typed error, and Effect.catch to recover.",
    },
    type: "problem",
  },
});

/** `throw` statements. */
const noThrowRule = defineRule({
  createOnce(context) {
    return {
      ThrowStatement(node) {
        context.report({ messageId: "throw", node });
      },
    };
  },
  meta: {
    docs: { description: "Disallow throw; fail with a typed error." },
    messages: {
      throw:
        "No throw: return Effect.fail with a Schema.TaggedError (or Effect.die for a defect).",
    },
    type: "problem",
  },
});

/** Lint rules keeping `src/` Effect-native. */
const effectNativePlugin = eslintCompatPlugin({
  meta: { name: "effect-native" },
  rules: {
    "no-async": noAsyncRule,
    "no-promise": noPromiseRule,
    "no-throw": noThrowRule,
    "no-try": noTryRule,
  },
});

export default effectNativePlugin;
