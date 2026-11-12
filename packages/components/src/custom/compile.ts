import {
  type Expression as AstExpression,
  type Statement as AstStatement,
  type ForStatement,
  type Node,
  parse,
} from "acorn";
import type { ComponentDefinition } from "../define.js";
import {
  CALLS,
  compileEvaluation,
  type Expression,
  fail,
  COMPONENT_PROGRAM_LIMITS as limits,
  number,
  read,
  type Statement,
  string,
  type Value,
} from "./runtime.js";

type Scope = ReadonlyMap<string, number>;
const programWork = new WeakMap<ComponentDefinition["evaluate"], number>();

export const componentProgramWork = (evaluate: ComponentDefinition["evaluate"]) =>
  programWork.get(evaluate) ?? 0;
const reserved = new Set(["props", "ctx", "layers", "Math", "solid", "text", "layer"]);
const context = new Set(["frame", "fps", "durationFrames", "width", "height", "seed", "depth"]);
const blocked = new Set(["__proto__", "constructor", "prototype"]);

function invalid(node: Node, message: string): never {
  const position = node.loc?.start;
  return fail(position ? `${position.line}:${position.column + 1}: ${message}` : message);
}

function key(node: Node, name: string): string {
  if (blocked.has(name) || name.length > 64) invalid(node, "invalid field name");
  return name;
}

function fields(node: AstExpression): Map<string, AstExpression> {
  if (node.type !== "ObjectExpression") invalid(node, "expected an object literal");
  const out = new Map<string, AstExpression>();
  for (const prop of node.properties) {
    if (prop.type !== "Property" || prop.kind !== "init" || prop.method || prop.computed)
      invalid(prop, "expected a plain object field");
    const name =
      prop.key.type === "Identifier"
        ? prop.key.name
        : prop.key.type === "Literal" && typeof prop.key.value === "string"
          ? prop.key.value
          : undefined;
    if (name === undefined || out.has(name)) invalid(prop, "expected a unique field name");
    out.set(key(prop, name), prop.value as AstExpression);
  }
  return out;
}

function path(node: Node, remaining = 4): string | undefined {
  if (remaining === 0) return undefined;
  const expr = node as AstExpression;
  if (expr.type === "Identifier") return expr.name;
  if (
    expr.type !== "MemberExpression" ||
    expr.computed ||
    expr.optional ||
    expr.property.type !== "Identifier"
  )
    return undefined;
  const base = path(expr.object, remaining - 1);
  return base === undefined ? undefined : `${base}.${expr.property.name}`;
}

function primitive(value: Value): string {
  if (value !== null && typeof value === "object")
    fail("expected a primitive for string interpolation");
  return String(value);
}

const binary = new Map<string, (left: Value, right: Value) => Value>([
  [
    "+",
    (a, b) =>
      typeof a === "string" || typeof b === "string"
        ? string(primitive(a) + primitive(b))
        : number(number(a) + number(b)),
  ],
  ["-", (a, b) => number(number(a) - number(b))],
  ["*", (a, b) => number(number(a) * number(b))],
  ["/", (a, b) => number(number(a) / number(b))],
  ["%", (a, b) => number(number(a) % number(b))],
  ["===", (a, b) => a === b],
  ["!==", (a, b) => a !== b],
  ["<", (a, b) => number(a) < number(b)],
  ["<=", (a, b) => number(a) <= number(b)],
  [">", (a, b) => number(a) > number(b)],
  [">=", (a, b) => number(a) >= number(b)],
]);

class Compiler {
  private slots = 0;
  private work = 0;
  private multiplier = 1;

  constructor(private readonly props: ComponentDefinition["props"]) {}

  private charge(node: Node, depth: number) {
    if (depth > limits.depth) invalid(node, `component nesting exceeds ${limits.depth}`);
    this.work += this.multiplier;
    if (this.work > limits.work) invalid(node, `component work exceeds ${limits.work} steps`);
  }

  private expression(node: AstExpression, scope: Scope, depth: number): Expression {
    this.charge(node, depth);
    const expression = (child: AstExpression) => this.expression(child, scope, depth + 1);
    switch (node.type) {
      case "Literal": {
        const value = node.value;
        if (typeof value === "number") number(value);
        if (typeof value === "string") string(value);
        if (
          value !== null &&
          typeof value !== "number" &&
          typeof value !== "string" &&
          typeof value !== "boolean"
        )
          invalid(node, "expected a data literal");
        return () => value;
      }
      case "Identifier": {
        const slot = scope.get(node.name);
        if (slot === undefined) invalid(node, `unknown local '${node.name.slice(0, 64)}'`);
        return ({ slots }) => slots[slot] as Value;
      }
      case "MemberExpression": {
        const property = node.property;
        if (node.optional) invalid(node, "optional access is unsupported");
        const name =
          !node.computed && property.type === "Identifier"
            ? property.name
            : node.computed &&
                property.type === "Literal" &&
                (property.value === 0 || property.value === 1)
              ? String(property.value)
              : undefined;
        if (name === undefined) invalid(node, "use a named field or point index 0 or 1");
        key(node, name);
        if (node.object.type === "Identifier") {
          if (node.object.name === "props") {
            if (!Object.hasOwn(this.props, name)) invalid(node, `unknown prop '${name}'`);
            return ({ props }) => props[name] as Value;
          }
          if (node.object.name === "ctx") {
            if (!context.has(name)) invalid(node, `unknown context field '${name}'`);
            return ({ ctx }) => read(ctx, name);
          }
        }
        const object = expression(node.object as AstExpression);
        return (state) => read(object(state), name);
      }
      case "ArrayExpression": {
        const elements = node.elements.map((child) => {
          if (!child || child.type === "SpreadElement")
            invalid(node, "use explicit array elements");
          return expression(child);
        });
        return (state) => elements.map((element) => element(state));
      }
      case "ObjectExpression": {
        const entries = [...fields(node)].map(
          ([name, child]) => [name, expression(child)] as const,
        );
        return (state) => {
          const out: Record<string, Value> = {};
          for (const [name, value] of entries) out[name] = value(state);
          return out;
        };
      }
      case "UnaryExpression": {
        const arg = expression(node.argument);
        if (node.operator === "!") return (state) => !arg(state);
        if (node.operator === "-") return (state) => -number(arg(state));
        return invalid(node, "unsupported unary operator");
      }
      case "BinaryExpression": {
        const op = binary.get(node.operator);
        if (op === undefined) invalid(node, "unsupported binary operator");
        const left = expression(node.left as AstExpression);
        const right = expression(node.right);
        return (state) => op(left(state), right(state));
      }
      case "LogicalExpression": {
        const left = expression(node.left);
        const right = expression(node.right);
        if (node.operator === "&&") return (state) => left(state) && right(state);
        if (node.operator === "||") return (state) => left(state) || right(state);
        return (state) => left(state) ?? right(state);
      }
      case "ConditionalExpression": {
        const test = expression(node.test);
        const yes = expression(node.consequent);
        const no = expression(node.alternate);
        return (state) => (test(state) ? yes(state) : no(state));
      }
      case "TemplateLiteral": {
        const parts = node.quasis.map((part) => string(part.value.cooked ?? undefined));
        const values = node.expressions.map(expression);
        return (state) => {
          let result = parts[0] ?? "";
          for (const [i, evaluate] of values.entries())
            result = string(result + primitive(evaluate(state)) + parts[i + 1]);
          return result;
        };
      }
      case "CallExpression": {
        const name = path(node.callee);
        const intrinsic = name === undefined ? undefined : CALLS.get(name);
        if (intrinsic === undefined || node.optional)
          invalid(node, "call a supported component intrinsic");
        const [arity, call] = intrinsic;
        if (node.arguments.length !== arity) invalid(node, `${name} expects ${arity} arguments`);
        const args = node.arguments.map((arg) => {
          if (arg.type === "SpreadElement") invalid(arg, "use explicit arguments");
          return expression(arg);
        });
        return (state) =>
          call(
            state,
            args.map((arg) => arg(state)),
          ) as Value;
      }
      default:
        return invalid(node, `unsupported expression ${node.type}`);
    }
  }

  private bind(scope: Map<string, number>, node: Node, name: string) {
    if (reserved.has(name) || scope.has(name))
      invalid(node, "local names must be unique and unreserved");
    const slot = this.slots++;
    scope.set(name, slot);
    return slot;
  }

  private statement(node: AstStatement, scope: Map<string, number>, depth: number): Statement {
    this.charge(node, depth);
    switch (node.type) {
      case "BlockStatement": {
        const inner = new Map(scope);
        const body = node.body.map((child) => this.statement(child, inner, depth + 1));
        return (state) => {
          for (const run of body) run(state);
        };
      }
      case "VariableDeclaration": {
        const [decl] = node.declarations;
        if (
          node.kind !== "const" ||
          node.declarations.length !== 1 ||
          decl?.id.type !== "Identifier" ||
          !decl.init
        )
          invalid(node, "declare one initialized const per statement");
        const evaluate = this.expression(decl.init, scope, depth + 1);
        const slot = this.bind(scope, decl.id, decl.id.name);
        return (state) => {
          state.slots[slot] = evaluate(state);
        };
      }
      case "IfStatement": {
        const test = this.expression(node.test, scope, depth + 1);
        const yes = this.statement(node.consequent, new Map(scope), depth + 1);
        const no = node.alternate
          ? this.statement(node.alternate, new Map(scope), depth + 1)
          : undefined;
        return (state) => {
          if (test(state)) yes(state);
          else no?.(state);
        };
      }
      case "ForStatement":
        return this.loop(node, scope, depth);
      case "ExpressionStatement": {
        const call = node.expression;
        const arg = call.type === "CallExpression" ? call.arguments[0] : undefined;
        if (
          call.type !== "CallExpression" ||
          call.optional ||
          path(call.callee) !== "layers.push" ||
          call.arguments.length !== 1 ||
          !arg ||
          arg.type === "SpreadElement"
        )
          invalid(node, "only layers.push(layer) is allowed as a statement");
        const value = this.expression(arg, scope, depth + 1);
        return (state) => {
          if (state.layers.length >= limits.layers)
            fail(`component output exceeds ${limits.layers} layers`);
          state.layers.push(value(state));
        };
      }
      default:
        return invalid(node, `unsupported statement ${node.type}`);
    }
  }

  private loop(node: ForStatement, outer: Scope, depth: number): Statement {
    const { init, test, update } = node;
    const decl = init?.type === "VariableDeclaration" ? init.declarations[0] : undefined;
    const name = decl?.id.type === "Identifier" ? decl.id.name : undefined;
    if (
      !name ||
      init?.type !== "VariableDeclaration" ||
      init.kind !== "let" ||
      init.declarations.length !== 1 ||
      decl?.init?.type !== "Literal" ||
      decl.init.value !== 0 ||
      test?.type !== "BinaryExpression" ||
      test.operator !== "<" ||
      test.left.type !== "Identifier" ||
      test.left.name !== name ||
      test.right.type !== "Literal" ||
      typeof test.right.value !== "number" ||
      !Number.isInteger(test.right.value) ||
      test.right.value < 1 ||
      test.right.value > limits.iterations ||
      update?.type !== "UpdateExpression" ||
      update.operator !== "++" ||
      update.argument.type !== "Identifier" ||
      update.argument.name !== name
    )
      invalid(node, `use for (let i = 0; i < N; i++) with N from 1 to ${limits.iterations}`);
    const count = test.right.value;
    const inner = new Map(outer);
    const slot = this.bind(inner, node, name);
    const previous = this.multiplier;
    this.multiplier *= count;
    const run = this.statement(node.body, inner, depth + 1);
    this.multiplier = previous;
    return (state) => {
      for (let i = 0; i < count; i++) {
        state.slots[slot] = i;
        run(state);
      }
    };
  }

  compile(body: AstStatement[]): ComponentDefinition["evaluate"] {
    const first = body[0];
    const last = body.at(-1);
    const decl = first?.type === "VariableDeclaration" ? first.declarations[0] : undefined;
    if (
      first?.type !== "VariableDeclaration" ||
      first.kind !== "const" ||
      first.declarations.length !== 1 ||
      decl?.id.type !== "Identifier" ||
      decl.id.name !== "layers" ||
      decl.init?.type !== "ArrayExpression" ||
      decl.init.elements.length !== 0
    )
      fail("evaluate must begin with const layers = []");
    if (last?.type !== "ReturnStatement" || !last.argument)
      fail("evaluate must end with return { width, height, layers }");
    const result = fields(last.argument);
    const layers = result.get("layers");
    const width = result.get("width");
    const height = result.get("height");
    if (
      layers?.type !== "Identifier" ||
      layers.name !== "layers" ||
      !width ||
      !height ||
      [...result.keys()].some((name) => !["width", "height", "layers", "background"].includes(name))
    )
      invalid(last, "return width, height, layers and optional background");
    const scope = new Map<string, number>();
    const statements = body.slice(1, -1).map((node) => this.statement(node, scope, 1));
    const background = result.get("background");
    const evaluate = compileEvaluation(
      statements,
      this.expression(width, scope, 1),
      this.expression(height, scope, 1),
      background === undefined ? undefined : this.expression(background, scope, 1),
    );
    programWork.set(evaluate, this.work);
    return evaluate;
  }
}

/** Compile stripped TypeScript to trusted closures. The authored source is never executed as JS. */
export function compileComponentProgram(
  source: string,
  props: ComponentDefinition["props"],
): ComponentDefinition["evaluate"] {
  if (
    source.length > limits.sourceBytes ||
    new TextEncoder().encode(source).length > limits.sourceBytes
  )
    fail(`component source exceeds ${limits.sourceBytes} UTF-8 bytes`);
  let tokens = 0;
  const parsed = parse(source, {
    ecmaVersion: 2022,
    sourceType: "module",
    locations: true,
    onToken: () => {
      if (++tokens > limits.syntaxNodes)
        fail(`component source exceeds ${limits.syntaxNodes} tokens`);
    },
  });
  const exported = parsed.body[0];
  const fn = exported?.type === "ExportNamedDeclaration" ? exported.declaration : undefined;
  if (
    parsed.body.length !== 1 ||
    fn?.type !== "FunctionDeclaration" ||
    fn.id?.name !== "evaluate" ||
    fn.async ||
    fn.generator ||
    fn.params.length !== 2 ||
    fn.params[0]?.type !== "Identifier" ||
    fn.params[0].name !== "props" ||
    fn.params[1]?.type !== "Identifier" ||
    fn.params[1].name !== "ctx" ||
    fn.body.type !== "BlockStatement"
  )
    fail("expected export function evaluate(props, ctx) { ... }");
  return new Compiler(props).compile(fn.body.body);
}
