import {
  createApp,
  createRouter,
  send,
  setResponseStatus,
  toWebHandler,
  type EventHandler,
} from 'h3';
import mealDelete from '#server/routes/meal/[id]/index.delete';
import mealsGet from '#server/routes/meals/index.get';
import mealsPost from '#server/routes/meals/index.post';
import assignRider from '#server/routes/order/[id]/assign-rider.post';
import deliver from '#server/routes/order/[id]/deliver.post';
import fulfill from '#server/routes/order/[id]/fulfill.post';
import ordersGet from '#server/routes/orders/index.get';
import ordersPost from '#server/routes/orders/index.post';
import usersDelete from '#server/routes/users/index.delete';
import usersPost from '#server/routes/users/index.post';

type Method = 'get' | 'post' | 'delete';

/**
 * The app's API routes, as Nitro mounts them from server/routes/ (`[id]` becomes `:id`, and the
 * file's `.get`/`.post`/`.delete` suffix is the method). routes.test.ts checks this list against
 * the files.
 */
export const ROUTES: ReadonlyArray<{
  method: Method;
  path: string;
  file: string;
  handler: EventHandler;
}> = [
  { method: 'get', path: '/meals', file: 'meals/index.get.ts', handler: mealsGet },
  { method: 'post', path: '/meals', file: 'meals/index.post.ts', handler: mealsPost },
  { method: 'delete', path: '/meal/:id', file: 'meal/[id]/index.delete.ts', handler: mealDelete },
  { method: 'get', path: '/orders', file: 'orders/index.get.ts', handler: ordersGet },
  { method: 'post', path: '/orders', file: 'orders/index.post.ts', handler: ordersPost },
  {
    method: 'post',
    path: '/order/:id/fulfill',
    file: 'order/[id]/fulfill.post.ts',
    handler: fulfill,
  },
  {
    method: 'post',
    path: '/order/:id/assign-rider',
    file: 'order/[id]/assign-rider.post.ts',
    handler: assignRider,
  },
  {
    method: 'post',
    path: '/order/:id/deliver',
    file: 'order/[id]/deliver.post.ts',
    handler: deliver,
  },
  { method: 'post', path: '/users', file: 'users/index.post.ts', handler: usersPost },
  { method: 'delete', path: '/users', file: 'users/index.delete.ts', handler: usersDelete },
];

export interface Caller {
  user?: string;
  city?: string;
}

/** A response's status and parsed JSON body. */
export interface Reply<T = unknown> {
  status: number;
  body: T;
}

/**
 * Serves the routes in-process with h3, the server library Nitro runs them on. h3 on its own leaves
 * an error's `message` out of the JSON it answers with; Nitro's error handler, which the app runs
 * behind, puts it in. `onError` answers the way Nitro does for the errors the routes throw.
 */
export function testServer() {
  const router = createRouter();
  for (const { method, path, handler } of ROUTES) router[method](path, handler);
  const app = createApp({
    onError: (error, event) => {
      setResponseStatus(event, error.statusCode);
      const body = { statusCode: error.statusCode, message: error.unhandled ? '' : error.message };
      return send(event, JSON.stringify(body), 'application/json');
    },
  });
  app.use(router);
  const handle = toWebHandler(app);

  async function request<T>(
    method: Uppercase<Method>,
    path: string,
    { user = 'customer1', city = 'california' }: Caller = {},
    body?: unknown,
  ): Promise<Reply<T>> {
    const headers: Record<string, string> = { accept: 'application/json', user, city };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await handle(new Request(`http://localhost${path}`, init));
    const text = await response.text();
    return { status: response.status, body: (text === '' ? undefined : JSON.parse(text)) as T };
  }

  return {
    get: <T>(path: string, caller?: Caller) => request<T>('GET', path, caller),
    post: <T>(path: string, body?: unknown, caller?: Caller) =>
      request<T>('POST', path, caller, body),
    delete: <T>(path: string, body?: unknown, caller?: Caller) =>
      request<T>('DELETE', path, caller, body),
  };
}
