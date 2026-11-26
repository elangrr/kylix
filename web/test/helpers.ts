// A fake fetch for the JSON-RPC, answering from recorded responses.

import { base64FromText, textFromBase64 } from '../src/lib/parse.ts';

export interface RecordedCall {
  method: string;
  path?: string;
  data?: string;
  contentType: string | null;
}

/** An abci_query answer with the given text as Data. */
export function abciOk(text: string): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { response: { ResponseBase: { Error: null, Data: base64FromText(text), Events: null, Log: '', Info: '' }, Height: '0' } },
  };
}

/** An abci_query answer for a realm panic. */
export function abciPanic(message: string): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      response: {
        ResponseBase: { Error: { '@type': '/abci.StringError', value: message }, Data: null, Events: null, Log: `--= Error =--\nData: ${message}`, Info: '' },
        Height: '0',
      },
    },
  };
}

type Route = unknown | ((call: RecordedCall) => unknown);

/**
 * routes maps "<abci path> <decoded data>" (or "status") to a JSON-RPC answer.
 * Unknown requests get a realm panic, so a test fails loudly.
 */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: RecordedCall[] = [];
  const fn = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: { path?: string; data?: string } };
    const headers = new Headers(init?.headers);
    const call: RecordedCall = { method: body.method, contentType: headers.get('content-type') };
    let key = body.method;
    if (body.method === 'abci_query') {
      call.path = body.params.path ?? '';
      call.data = body.params.data ? textFromBase64(body.params.data) : '';
      key = `${call.path} ${call.data}`;
    }
    calls.push(call);
    const route = routes[key];
    const answer = typeof route === 'function' ? (route as (c: RecordedCall) => unknown)(call) : route;
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer ?? abciPanic(`no fixture for ${key}`)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn as typeof fetch, calls };
}

export const noSleep = async (): Promise<void> => {};
