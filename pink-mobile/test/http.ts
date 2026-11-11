import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

export interface Answer {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

interface Call {
  method?: string;
  query?: Record<string, string>;
  /** The X-User header; left out, the request has none. */
  persona?: string;
}

/**
 * Calls a Pages Router API handler with a request and a response that record only what the handlers
 * in pages/api use: the method, the query, the headers, `status`, `json` and `setHeader`.
 */
export async function call(handler: NextApiHandler, request: Call = {}): Promise<Answer> {
  const answer: Answer = { status: 0, body: undefined, headers: {} };
  const req = {
    method: request.method ?? 'GET',
    url: '/api/test',
    query: request.query ?? {},
    headers: request.persona === undefined ? {} : { 'x-user': request.persona },
  };
  const res = {
    status(code: number) {
      answer.status = code;
      return res;
    },
    json(body: unknown) {
      answer.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      answer.headers[name] = value;
      return res;
    },
  };
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return answer;
}
