export const queryMethods = ['run', 'all', 'get', 'exec'] as const;
export const queryOperations = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'PRAGMA',
  'VACUUM',
  'UNKNOWN',
] as const;
export type QueryMethod = (typeof queryMethods)[number];
export type QueryOperation = (typeof queryOperations)[number];
export interface SafeQueryDetails {
  readonly method: QueryMethod;
  readonly operation: QueryOperation;
  readonly text?: string;
  readonly table?: QueryTable;
}
export interface QueryCompletion {
  readonly outcome: 'success' | 'error';
  readonly durationMs: number;
}
export type QueryObserver = (
  details: Readonly<SafeQueryDetails>
) => ((completion: Readonly<QueryCompletion>) => void) | undefined;

const tableNames = [
  'customers',
  '__drizzle_migrations',
  'sqlite_master',
  'sqlite_sequence',
  '__new_customers',
  '__customer_sequence',
] as const;
export type QueryTable = (typeof tableNames)[number];
const tables = new Set<string>(tableNames);
const identifiers = new Map(
  [
    ...tables,
    'id',
    'customerNumber',
    'revision',
    'firstName',
    'lastName',
    'address',
    'city',
    'province',
    'postalCode',
    'phone',
    'homePhone',
    'email',
    'stock',
    'balance',
    'previousBalance',
    'donate',
    'comments',
    'hash',
    'created_at',
    'name',
    'type',
    'sql',
    'seq',
    'candidate',
    'sp',
    'customers_customer_number_unique',
  ].map(value => [value.toLowerCase(), value])
);
const functions = new Set(['COALESCE', 'MIN', 'MAX', 'COUNT', 'CAST', 'TYPEOF']);
const keywords = new Set([
  ...queryOperations,
  ...functions,
  'FROM',
  'WHERE',
  'SET',
  'INTO',
  'VALUES',
  'RETURNING',
  'AS',
  'UNION',
  'ALL',
  'ORDER',
  'BY',
  'ASC',
  'DESC',
  'LIMIT',
  'OFFSET',
  'AND',
  'OR',
  'NOT',
  'IS',
  'NULL',
  'TRUE',
  'FALSE',
  'IN',
  'LIKE',
  'GLOB',
  'REGEXP',
  'MATCH',
  'BETWEEN',
  'DISTINCT',
  'DEFERRED',
  'IMMEDIATE',
  'EXCLUSIVE',
  'CONCURRENT',
  'TRANSACTION',
  'TO',
  'TABLE_INFO',
  'INDEX_LIST',
  'INDEX_INFO',
  'TEXT',
]);
const operators = new Set([
  '(',
  ')',
  ',',
  '.',
  '*',
  '+',
  '-',
  '/',
  '%',
  '=',
  '<',
  '>',
  '<=',
  '>=',
  '<>',
  '!=',
  '||',
]);
const whitespacePattern = /^\s+/;
const newlinePattern = /[\r\n]/;
const blobPrefix = /^[xX]'/;
const blobContents = /^(?:[a-f0-9]{2})*$/i;
const trailingTerminator = /^;\s*$/;
const operationPrefix = /^\s*(?:--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/\s*)*([a-z]+)/i;
const bareWord = /^[a-z_][a-z_0-9]*/i;
const numberLiteral = /^(?:0x[0-9a-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i;
const parameter = /^(?:\?\d*|[:@$][a-z_][a-z_0-9]*)/i;
const savepoint = /^sp\d{1,3}$/i;

type Token = {kind: 'word' | 'identifier' | 'value' | 'operator'; value: string};

function hasControlCharacters(source: string) {
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127) {
      return true;
    }
  }

  return false;
}

function tokenize(source: string): Token[] | undefined {
  if (source.length > 16384 || hasControlCharacters(source)) {
    return;
  }

  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    if (tokens.length >= 2048) {
      return;
    }

    const rest = source.slice(position);
    const whitespace = whitespacePattern.exec(rest);
    if (whitespace) {
      position += whitespace[0].length;
      continue;
    }

    if (rest.startsWith('--')) {
      const end = rest.search(newlinePattern);
      position += end < 0 ? rest.length : end;
      continue;
    }

    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      if (end < 0) {
        return;
      }

      position += end + 2;
      continue;
    }

    const blob = blobPrefix.test(rest);
    const quote = blob ? "'" : rest[0];
    if (quote === "'" || quote === '"' || quote === '`' || quote === '[') {
      const closing = quote === '[' ? ']' : quote;
      let end = blob ? 2 : 1;
      let contents = '';
      let closed = false;
      while (end < rest.length) {
        if (rest[end] === closing) {
          if (quote !== '[' && rest[end + 1] === closing) {
            contents += closing;
            end += 2;
            continue;
          }

          end += 1;
          closed = true;
          break;
        }

        contents += rest[end];
        end += 1;
      }

      if (!closed || (blob && !blobContents.test(contents))) {
        return;
      }

      if (quote === "'") {
        tokens.push({kind: 'value', value: '?'});
      } else {
        const name = identifiers.get(contents.toLowerCase());
        if (!name) {
          return;
        }

        tokens.push({kind: 'identifier', value: name});
      }

      position += end;
      continue;
    }

    const binding = parameter.exec(rest);
    if (binding) {
      tokens.push({kind: 'value', value: '?'});
      position += binding[0].length;
      continue;
    }

    const numeric = numberLiteral.exec(rest);
    if (numeric) {
      tokens.push({kind: 'value', value: '?'});
      position += numeric[0].length;
      continue;
    }

    const word = bareWord.exec(rest);
    if (word) {
      const upper = word[0].toUpperCase();
      const name = identifiers.get(word[0].toLowerCase());
      if (keywords.has(upper)) {
        tokens.push({kind: 'word', value: upper});
      } else if (name) {
        tokens.push({kind: 'identifier', value: name});
      } else if (savepoint.test(word[0])) {
        tokens.push({kind: 'identifier', value: 'sp'});
      } else {
        return;
      }

      position += word[0].length;
      continue;
    }

    if (rest[0] === ';' && trailingTerminator.test(rest)) {
      position = source.length;
      continue;
    }

    const operator = operators.has(rest.slice(0, 2)) ? rest.slice(0, 2) : rest[0]!;
    if (!operators.has(operator)) {
      return;
    }

    tokens.push({kind: 'operator', value: operator});
    position += operator.length;
  }

  return tokens;
}

class QueryShape {
  private position = 0;
  private depth = 0;
  readonly collections = new Set<QueryTable>();
  constructor(private readonly tokens: Token[]) {}
  private peek(value: string) {
    return this.tokens[this.position]?.value === value;
  }
  private take(value: string) {
    if (!this.peek(value)) {
      return false;
    }

    this.position += 1;
    return true;
  }
  private require(value: string) {
    if (!this.take(value)) {
      throw new Error();
    }
  }
  private identifier() {
    const token = this.tokens[this.position++];
    if (token?.kind !== 'identifier' || token.value === 'sp') {
      throw new Error();
    }

    return token.value;
  }
  private table() {
    const name = this.identifier();
    if (!tables.has(name)) {
      throw new Error();
    }

    this.collections.add(name as QueryTable);
  }
  private list(work: () => void) {
    work();
    while (this.take(',')) {
      work();
    }
  }
  private atom() {
    if (++this.depth > 32) {
      throw new Error();
    }

    try {
      if (this.take('(')) {
        if (this.peek('SELECT')) {
          this.select();
        } else {
          this.expression();
        }

        this.require(')');
      } else if (this.take('-') || this.take('+') || this.take('NOT')) {
        const prefix = this.tokens[this.position - 1]!;
        if (prefix.kind === 'operator' && this.tokens[this.position]?.kind === 'value') {
          prefix.value = '';
        }

        this.atom();
      } else if (this.tokens[this.position]?.kind === 'value') {
        this.position += 1;
      } else if (this.take('NULL') || this.take('TRUE') || this.take('FALSE')) {
        this.tokens[this.position - 1] = {kind: 'value', value: '?'};
      } else if (this.take('*')) {
        return;
      } else if (functions.has(this.tokens[this.position]?.value ?? '')) {
        const name = this.tokens[this.position++]!.value;
        this.require('(');
        if (name === 'CAST') {
          this.expression();
          this.require('AS');
          this.require('TEXT');
        } else {
          this.list(() => this.expression());
        }

        this.require(')');
      } else {
        const name = this.identifier();
        if (this.take('.')) {
          if (!tables.has(name)) {
            throw new Error();
          }

          this.identifier();
        }
      }
    } finally {
      this.depth -= 1;
    }
  }
  private expression() {
    this.atom();
    while (true) {
      const next = this.tokens[this.position]?.value;
      if (
        next &&
        [
          '+',
          '-',
          '*',
          '/',
          '%',
          '||',
          '=',
          '!=',
          '<>',
          '<',
          '>',
          '<=',
          '>=',
          'AND',
          'OR',
          'LIKE',
          'GLOB',
          'REGEXP',
          'MATCH',
        ].includes(next)
      ) {
        this.position += 1;
        this.atom();
      } else if (this.take('IS')) {
        this.take('NOT');
        this.atom();
      } else if (
        this.peek('IN') ||
        (this.peek('NOT') && this.tokens[this.position + 1]?.value === 'IN')
      ) {
        this.take('NOT');
        this.require('IN');
        this.require('(');
        if (this.peek('SELECT')) {
          this.select();
        } else {
          this.list(() => this.expression());
        }

        this.require(')');
      } else if (this.take('BETWEEN')) {
        this.atom();
        this.require('AND');
        this.atom();
      } else {
        break;
      }
    }
  }
  private select() {
    if (++this.depth > 32) {
      throw new Error();
    }

    try {
      this.selectBody();
    } finally {
      this.depth -= 1;
    }
  }
  private selectBody() {
    this.require('SELECT');
    this.take('DISTINCT');
    this.list(() => {
      this.expression();
      if (this.take('AS') && this.identifier() !== 'candidate') {
        throw new Error();
      }
    });
    if (this.take('FROM')) {
      if (this.take('(')) {
        this.select();
        this.require(')');
      } else {
        this.table();
      }
    }

    if (this.take('WHERE')) {
      this.expression();
    }

    if (this.take('UNION')) {
      this.require('ALL');
      this.select();
    }

    if (this.take('ORDER')) {
      this.require('BY');
      this.list(() => {
        this.expression();
        if (!this.take('ASC')) {
          this.take('DESC');
        }
      });
    }

    if (this.take('LIMIT')) {
      this.expression();
      if (this.take('OFFSET')) {
        this.expression();
      }
    }
  }
  parse(operation: QueryOperation) {
    if (operation === 'SELECT') {
      this.select();
    } else if (operation === 'INSERT') {
      this.require('INSERT');
      this.require('INTO');
      this.table();
      if (this.take('(')) {
        this.list(() => this.identifier());
        this.require(')');
      }

      if (this.take('VALUES')) {
        this.list(() => {
          this.require('(');
          this.list(() => this.expression());
          this.require(')');
        });
      } else {
        this.select();
      }

      if (this.take('RETURNING')) {
        this.list(() => this.expression());
      }
    } else if (operation === 'UPDATE') {
      this.require('UPDATE');
      this.table();
      this.require('SET');
      this.list(() => {
        this.identifier();
        this.require('=');
        this.expression();
      });
      if (this.take('WHERE')) {
        this.expression();
      }

      if (this.take('RETURNING')) {
        this.list(() => this.expression());
      }
    } else if (operation === 'DELETE') {
      this.require('DELETE');
      this.require('FROM');
      this.table();
      if (this.take('WHERE')) {
        this.expression();
      }

      if (this.take('RETURNING')) {
        this.list(() => this.expression());
      }
    } else if (operation === 'VACUUM') {
      this.require('VACUUM');
      if (this.take('INTO')) {
        this.require('?');
      }
    } else if (operation === 'PRAGMA') {
      this.require('PRAGMA');
      const pragma = this.tokens[this.position++]?.value;
      if (!['TABLE_INFO', 'INDEX_LIST', 'INDEX_INFO'].includes(pragma ?? '')) {
        throw new Error();
      }

      this.require('(');
      if (pragma === 'INDEX_INFO') {
        if (this.identifier() !== 'customers_customer_number_unique') {
          throw new Error();
        }

        this.collections.add('customers');
      } else {
        this.table();
      }

      this.require(')');
    } else if (operation === 'BEGIN') {
      this.require('BEGIN');
      for (const mode of ['DEFERRED', 'IMMEDIATE', 'EXCLUSIVE', 'CONCURRENT']) {
        if (this.take(mode)) {
          break;
        }
      }

      this.take('TRANSACTION');
    } else if (operation === 'COMMIT') {
      this.require('COMMIT');
      this.take('TRANSACTION');
    } else if (['ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(operation)) {
      this.require(operation);
      const named = operation !== 'ROLLBACK' || this.take('TO');
      if (named) {
        this.take('SAVEPOINT');
        if (this.tokens[this.position++]?.value !== 'sp') {
          throw new Error();
        }
      } else {
        this.take('TRANSACTION');
      }
    } else {
      throw new Error();
    }

    if (this.position !== this.tokens.length) {
      throw new Error();
    }
  }
}

export function safeQueryDetails(source: unknown, method: QueryMethod): SafeQueryDetails {
  let operation: QueryOperation = 'UNKNOWN';
  if (typeof source !== 'string') {
    return {method, operation};
  }

  if (source.length <= 16384) {
    const first = operationPrefix.exec(source)?.[1]?.toUpperCase();
    if (queryOperations.some(value => value === first)) {
      operation = first as QueryOperation;
    }
  }

  const minimal = {method, operation};
  try {
    const tokens = tokenize(source);
    if (!tokens?.length) {
      return minimal;
    }

    const shape = new QueryShape(tokens);
    shape.parse(operation);
    const text = tokens
      .filter(token => token.value !== '')
      .map(token => (token.kind === 'identifier' ? `"${token.value}"` : token.value))
      .join(' ');
    if (text.length > 4096) {
      return minimal;
    }

    const table = shape.collections.size === 1 ? [...shape.collections][0] : undefined;
    return {method, operation, text, ...(table ? {table} : {})};
  } catch {
    return minimal;
  }
}

export function safeQueryAttributes(details: SafeQueryDetails) {
  const attributes: Record<string, string> = {'db.system.name': 'sqlite'};
  if (queryMethods.includes(details.method)) {
    attributes['db.query.method'] = details.method;
  }

  if (queryOperations.includes(details.operation)) {
    attributes['db.operation.name'] = details.operation;
  }

  if (typeof details.text === 'string') {
    const checked = safeQueryDetails(details.text, details.method);
    if (checked.text === details.text && checked.operation === details.operation) {
      attributes['db.query.text'] = checked.text;
      if (checked.table === details.table && checked.table) {
        attributes['db.collection.name'] = checked.table;
      }
    }
  }

  return attributes;
}
