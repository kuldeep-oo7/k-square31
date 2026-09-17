"use strict";

/**
 * K²-Lang: Domain-Specific Quantitative Programming Language (DSL)
 *
 * A specialized declarative language for financial quantitative rule synthesis:
 * - Tokenizer / Lexer
 * - Recursive Descent AST Parser
 * - Sandboxed Dynamic Interpreter & Evaluation Runtime
 *
 * Example Syntax:
 * STRATEGY "InstitutionalAlphaBreakout"
 * REQUIRE MACRO_GATE == "NORMAL" AND INDIA_VIX < 22.0
 * SIGNAL BUY WHEN HURST > 0.55 AND VPIN < 0.30 AND (PATTERN == "DOUBLE_BOTTOM" OR CANDLE == "BULLISH_ENGULFING") AND NEURAL_ALPHA > 65
 * SET TARGET1 = SPOT * 1.025, TARGET2 = SPOT * 1.050, STOPLOSS = SPOT * 0.985, LOTS = 1
 */

// Token Types
const TOKEN_TYPES = {
  KEYWORD: "KEYWORD",
  IDENTIFIER: "IDENTIFIER",
  NUMBER: "NUMBER",
  STRING: "STRING",
  OPERATOR: "OPERATOR",
  PUNCTUATION: "PUNCTUATION"
};

const KEYWORDS = new Set([
  "STRATEGY", "REQUIRE", "SIGNAL", "WHEN", "SET",
  "AND", "OR", "NOT", "IN", "TRUE", "FALSE", "BUY", "SELL", "AVOID"
]);

/**
 * Tokenizer / Lexer
 */
function tokenize(input) {
  const tokens = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Single-line comments (# or //)
    if (ch === '#' || (ch === '/' && input[i + 1] === '/')) {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }

    // String literals
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = "";
      i++;
      while (i < n && input[i] !== quote) {
        str += input[i];
        i++;
      }
      i++; // Skip closing quote
      tokens.push({ type: TOKEN_TYPES.STRING, value: str });
      continue;
    }

    // Numbers (integers & floats)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(input[i + 1]))) {
      let numStr = "";
      while (i < n && (/[0-9]/.test(input[i]) || input[i] === '.')) {
        numStr += input[i];
        i++;
      }
      tokens.push({ type: TOKEN_TYPES.NUMBER, value: parseFloat(numStr) });
      continue;
    }

    // Multi-character operators: ==, !=, >=, <=
    const twoChars = input.slice(i, i + 2);
    if (["==", "!=", ">=", "<="].includes(twoChars)) {
      tokens.push({ type: TOKEN_TYPES.OPERATOR, value: twoChars });
      i += 2;
      continue;
    }

    // Single-character operators
    if (['>', '<', '=', '+', '-', '*', '/'].includes(ch)) {
      tokens.push({ type: TOKEN_TYPES.OPERATOR, value: ch });
      i++;
      continue;
    }

    // Punctuation: (, ), [, ], comma
    if (['(', ')', '[', ']', ','].includes(ch)) {
      tokens.push({ type: TOKEN_TYPES.PUNCTUATION, value: ch });
      i++;
      continue;
    }

    // Identifiers & Keywords
    if (/[a-zA-Z_]/.test(ch)) {
      let word = "";
      while (i < n && /[a-zA-Z0-9_]/.test(input[i])) {
        word += input[i];
        i++;
      }
      const upper = word.toUpperCase();
      if (KEYWORDS.has(upper)) {
        tokens.push({ type: TOKEN_TYPES.KEYWORD, value: upper });
      } else {
        tokens.push({ type: TOKEN_TYPES.IDENTIFIER, value: word });
      }
      continue;
    }

    // Unknown character
    throw new Error(`K²-Lang Syntax Error: Unexpected character '${ch}' at index ${i}`);
  }

  return tokens;
}

/**
 * Recursive Descent AST Parser
 */
class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos] || null;
  }

  consume(expectedType, expectedValue) {
    const tok = this.peek();
    if (!tok) throw new Error(`K²-Lang Parse Error: Unexpected end of input`);
    if (expectedType && tok.type !== expectedType) {
      throw new Error(`K²-Lang Parse Error: Expected ${expectedType}, got ${tok.type} ('${tok.value}')`);
    }
    if (expectedValue && tok.value !== expectedValue) {
      throw new Error(`K²-Lang Parse Error: Expected '${expectedValue}', got '${tok.value}'`);
    }
    this.pos++;
    return tok;
  }

  parse() {
    const ast = {
      type: "Program",
      strategyName: "DefaultStrategy",
      requires: null,
      signals: [],
      assignments: {}
    };

    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (!tok) break;

      if (tok.type === TOKEN_TYPES.KEYWORD && tok.value === "STRATEGY") {
        this.consume();
        const nameTok = this.consume(TOKEN_TYPES.STRING);
        ast.strategyName = nameTok.value;
      } else if (tok.type === TOKEN_TYPES.KEYWORD && tok.value === "REQUIRE") {
        this.consume();
        ast.requires = this.parseExpression();
      } else if (tok.type === TOKEN_TYPES.KEYWORD && tok.value === "SIGNAL") {
        this.consume();
        const actionTok = this.consume(TOKEN_TYPES.KEYWORD); // BUY / SELL / AVOID
        this.consume(TOKEN_TYPES.KEYWORD, "WHEN");
        const condition = this.parseExpression();
        ast.signals.push({ action: actionTok.value, condition });
      } else if (tok.type === TOKEN_TYPES.KEYWORD && tok.value === "SET") {
        this.consume();
        ast.assignments = this.parseAssignmentList();
      } else {
        throw new Error(`K²-Lang Parse Error: Unexpected top-level token '${tok.value}'`);
      }
    }

    return ast;
  }

  parseAssignmentList() {
    const assignments = {};
    while (this.pos < this.tokens.length) {
      const idTok = this.consume(TOKEN_TYPES.IDENTIFIER);
      this.consume(TOKEN_TYPES.OPERATOR, "=");
      const valExpr = this.parseExpression();
      assignments[idTok.value.toUpperCase()] = valExpr;

      const next = this.peek();
      if (next && next.type === TOKEN_TYPES.PUNCTUATION && next.value === ",") {
        this.consume();
      } else {
        break;
      }
    }
    return assignments;
  }

  parseExpression() {
    return this.parseOr();
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek() && this.peek().type === TOKEN_TYPES.KEYWORD && this.peek().value === "OR") {
      this.consume();
      const right = this.parseAnd();
      left = { type: "LogicalExpression", operator: "OR", left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseComparison();
    while (this.peek() && this.peek().type === TOKEN_TYPES.KEYWORD && this.peek().value === "AND") {
      this.consume();
      const right = this.parseComparison();
      left = { type: "LogicalExpression", operator: "AND", left, right };
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    const tok = this.peek();

    if (tok && (tok.type === TOKEN_TYPES.OPERATOR && ["==", "!=", ">", "<", ">=", "<="].includes(tok.value))) {
      this.consume();
      const right = this.parseAdditive();
      return { type: "BinaryExpression", operator: tok.value, left, right };
    }

    if (tok && tok.type === TOKEN_TYPES.KEYWORD && tok.value === "IN") {
      this.consume();
      this.consume(TOKEN_TYPES.PUNCTUATION, "[");
      const list = [];
      while (this.peek() && !(this.peek().type === TOKEN_TYPES.PUNCTUATION && this.peek().value === "]")) {
        const item = this.parsePrimary();
        list.push(item);
        if (this.peek() && this.peek().type === TOKEN_TYPES.PUNCTUATION && this.peek().value === ",") {
          this.consume();
        }
      }
      this.consume(TOKEN_TYPES.PUNCTUATION, "]");
      return { type: "InExpression", left, list };
    }

    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.peek() && this.peek().type === TOKEN_TYPES.OPERATOR && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.consume().value;
      const right = this.parseMultiplicative();
      left = { type: "BinaryExpression", operator: op, left, right };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parsePrimary();
    while (this.peek() && this.peek().type === TOKEN_TYPES.OPERATOR && (this.peek().value === "*" || this.peek().value === "/")) {
      const op = this.consume().value;
      const right = this.parsePrimary();
      left = { type: "BinaryExpression", operator: op, left, right };
    }
    return left;
  }

  parsePrimary() {
    const tok = this.peek();
    if (!tok) throw new Error("K²-Lang Parse Error: Unexpected end of input in primary");

    // Parenthesized expression
    if (tok.type === TOKEN_TYPES.PUNCTUATION && tok.value === "(") {
      this.consume();
      const expr = this.parseExpression();
      this.consume(TOKEN_TYPES.PUNCTUATION, ")");
      return expr;
    }

    // NOT unary
    if (tok.type === TOKEN_TYPES.KEYWORD && tok.value === "NOT") {
      this.consume();
      const argument = this.parsePrimary();
      return { type: "UnaryExpression", operator: "NOT", argument };
    }

    // Literals
    if (tok.type === TOKEN_TYPES.NUMBER) {
      this.consume();
      return { type: "Literal", value: tok.value };
    }
    if (tok.type === TOKEN_TYPES.STRING) {
      this.consume();
      return { type: "Literal", value: tok.value };
    }
    if (tok.type === TOKEN_TYPES.KEYWORD && (tok.value === "TRUE" || tok.value === "FALSE")) {
      this.consume();
      return { type: "Literal", value: tok.value === "TRUE" };
    }

    // Identifiers
    if (tok.type === TOKEN_TYPES.IDENTIFIER) {
      this.consume();
      return { type: "Identifier", name: tok.value.toUpperCase() };
    }

    throw new Error(`K²-Lang Parse Error: Unexpected token '${tok.value}'`);
  }
}

/**
 * Sandboxed Dynamic Evaluator / Runtime
 */
function evaluateNode(node, context) {
  if (!node) return null;

  switch (node.type) {
    case "Literal":
      return node.value;

    case "Identifier": {
      const key = node.name.toUpperCase();
      if (key in context) return context[key];
      // Check case-insensitive
      const found = Object.keys(context).find(k => k.toUpperCase() === key);
      return found ? context[found] : null;
    }

    case "UnaryExpression":
      if (node.operator === "NOT") {
        return !evaluateNode(node.argument, context);
      }
      break;

    case "BinaryExpression": {
      const left = evaluateNode(node.left, context);
      const right = evaluateNode(node.right, context);

      switch (node.operator) {
        case "+": return Math.round((Number(left) + Number(right) + Number.EPSILON) * 10000) / 10000;
        case "-": return Math.round((Number(left) - Number(right) + Number.EPSILON) * 10000) / 10000;
        case "*": return Math.round((Number(left) * Number(right) + Number.EPSILON) * 10000) / 10000;
        case "/": return Number(right) !== 0 ? Math.round((Number(left) / Number(right) + Number.EPSILON) * 10000) / 10000 : 0;
        case ">": return Number(left) > Number(right);
        case "<": return Number(left) < Number(right);
        case ">=": return Number(left) >= Number(right);
        case "<=": return Number(left) <= Number(right);
        case "==": return String(left).toUpperCase() === String(right).toUpperCase();
        case "!=": return String(left).toUpperCase() !== String(right).toUpperCase();
      }
      break;
    }

    case "LogicalExpression": {
      if (node.operator === "AND") {
        return Boolean(evaluateNode(node.left, context)) && Boolean(evaluateNode(node.right, context));
      }
      if (node.operator === "OR") {
        return Boolean(evaluateNode(node.left, context)) || Boolean(evaluateNode(node.right, context));
      }
      break;
    }

    case "InExpression": {
      const leftVal = String(evaluateNode(node.left, context)).toUpperCase();
      const listVals = node.list.map(item => String(evaluateNode(item, context)).toUpperCase());
      return listVals.includes(leftVal);
    }
  }

  return null;
}

/**
 * Evaluates full K²-Lang AST against a candidate's market context
 */
function executeK2Strategy(scriptOrAst, context) {
  let ast = scriptOrAst;
  if (typeof scriptOrAst === "string") {
    const tokens = tokenize(scriptOrAst);
    const parser = new Parser(tokens);
    ast = parser.parse();
  }

  const result = {
    strategy: ast.strategyName,
    requirementPassed: true,
    triggeredAction: null,
    assignments: {},
    passed: false
  };

  // 1. Evaluate REQUIRE block
  if (ast.requires) {
    const reqPassed = Boolean(evaluateNode(ast.requires, context));
    result.requirementPassed = reqPassed;
    if (!reqPassed) {
      result.reasons = ["Strategy preconditions (REQUIRE) failed."];
      return result;
    }
  }

  // 2. Evaluate SIGNAL WHEN blocks
  for (const sig of ast.signals) {
    const triggered = Boolean(evaluateNode(sig.condition, context));
    if (triggered) {
      result.triggeredAction = sig.action;
      result.passed = true;
      break;
    }
  }

  // 3. Evaluate SET assignments
  if (result.passed && ast.assignments) {
    for (const [key, expr] of Object.entries(ast.assignments)) {
      result.assignments[key] = evaluateNode(expr, context);
    }
  }

  return result;
}

module.exports = {
  tokenize,
  Parser,
  evaluateNode,
  executeK2Strategy
};
