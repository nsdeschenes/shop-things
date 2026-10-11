import type {Database} from '@tursodatabase/database';

import {safeQueryDetails} from './queryTelemetry.js';
import type {QueryObserver, SafeQueryDetails, QueryMethod} from './queryTelemetry.js';

type Statement = Awaited<ReturnType<Database['prepare']>>;
const executionMethods = new Set(['run', 'all', 'get']);

export function observeQueries(client: Database, observer: QueryObserver): Database {
  async function execute<T>(
    details: SafeQueryDetails,
    work: () => T | Promise<T>
  ): Promise<T> {
    let finish: ReturnType<QueryObserver>;
    try {
      finish = observer(Object.freeze(details));
    } catch {}

    const start = performance.now();
    let outcome: 'success' | 'error' = 'error';
    try {
      const result = await work();
      outcome = 'success';
      return result;
    } finally {
      const durationMs = Math.max(0, performance.now() - start);
      try {
        finish?.(Object.freeze({outcome, durationMs}));
      } catch {}
    }
  }

  function statementFacade(statement: Statement, source: unknown): Statement {
    const details = safeQueryDetails(source, 'run');
    const methods = new Map<PropertyKey, unknown>();
    const facade = new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function' || property === 'constructor') {
          return value;
        }

        if (!methods.has(property)) {
          methods.set(
            property,
            executionMethods.has(String(property))
              ? (...args: unknown[]) =>
                  execute({...details, method: property as QueryMethod}, () =>
                    Reflect.apply(value, target, args)
                  )
              : (...args: unknown[]) => {
                  const result = Reflect.apply(value, target, args);
                  return result === target ? facade : result;
                }
          );
        }

        return methods.get(property);
      },
    });
    return facade;
  }

  const methods = new Map<PropertyKey, unknown>();
  const facade = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function' || property === 'constructor') {
        return value;
      }

      if (!methods.has(property)) {
        if (executionMethods.has(String(property)) || property === 'exec') {
          methods.set(property, (source: unknown, ...args: unknown[]) =>
            execute(safeQueryDetails(source, property as QueryMethod), () =>
              Reflect.apply(value, target, [source, ...args])
            )
          );
        } else if (property === 'prepare') {
          methods.set(property, (source: unknown, ...args: unknown[]) => {
            const result = Reflect.apply(value, target, [source, ...args]) as
              | Statement
              | Promise<Statement>;
            return result instanceof Promise
              ? result.then(statement => statementFacade(statement, source))
              : statementFacade(result, source);
          });
        } else {
          methods.set(property, (...args: unknown[]) =>
            Reflect.apply(value, property === 'transaction' ? facade : target, args)
          );
        }
      }

      return methods.get(property);
    },
  });
  return facade;
}
