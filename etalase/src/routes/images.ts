import { Hono } from "hono";
import type { Env, Variables } from "../types";

const images = new Hono<{ Bindings: Env; Variables: Variables }>();

// Publik: GET /images/:key(termasuk subpath, mis. products/xxxx.jpg)
images.get("/*", async (c) => {
  const key = c.req.path.replace(/^\/images\//, "");
  if (!key) return c.notFound();

  const object = await c.env.IMAGES.get(key);
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Cache di edge selama 1 hari; gambar produk jarang berganti key (upload = key baru)
  headers.set("Cache-Control", "public, max-age=86400");

  return new Response(object.body, { headers });
});

export default images;
