#!/usr/bin/env node
/**
 * Regenerates showcase imagery from image-prompts.mjs through AI Horde
 * (aihorde.net, a volunteer GPU network; anonymous key, no account) with
 * FLUX.1 [schnell] (black-forest-labs, Apache-2.0). Output carries no
 * watermark. AI Horde defers image licensing to the model's licence.
 *
 *   node tools/showcase/gen-images.mjs [outDir]     default: tools/showcase/assets
 *
 * Resumable: existing files are kept, so delete a file to re-roll it. Each
 * write replaces that file's entry in PROVENANCE.json (prompt, seed, worker,
 * sha256, time). Not part of the harness run: the harness only reads assets/.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_JOBS } from "./image-prompts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(here, "assets"));
const MODEL = "Flux.1-Schnell fp8 (Compact)";
const HEADERS = { "content-type": "application/json", apikey: "0000000000", "Client-Agent": "pp-showcase-demo:1.0:anonymous" };
const provPath = path.join(out, "PROVENANCE.json");
const prov = existsSync(provPath) ? JSON.parse(readFileSync(provPath, "utf8")) : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function one([shop, name, width, height, prompt]) {
  mkdirSync(path.join(out, shop), { recursive: true });
  const rel = `${shop}/${name}.webp`;
  const file = path.join(out, shop, `${name}.webp`);
  if (existsSync(file)) return;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const sub = await (
        await fetch("https://aihorde.net/api/v2/generate/async", {
          method: "POST",
          headers: HEADERS,
          body: JSON.stringify({
            prompt,
            params: { width, height, steps: 4, cfg_scale: 1, sampler_name: "k_euler", n: 1 },
            models: [MODEL],
            r2: true,
            nsfw: false,
            censor_nsfw: true,
            slow_workers: true,
          }),
        })
      ).json();
      if (!sub.id) throw new Error(`submit: ${JSON.stringify(sub).slice(0, 200)}`);
      for (let i = 0; i < 200; i++) {
        await sleep(15000);
        const c = await (await fetch(`https://aihorde.net/api/v2/generate/check/${sub.id}`)).json();
        if (c.faulted || c.is_possible === false) throw new Error(`faulted: ${JSON.stringify(c).slice(0, 200)}`);
        if (c.done) break;
      }
      const s = await (await fetch(`https://aihorde.net/api/v2/generate/status/${sub.id}`)).json();
      const g = s.generations?.[0];
      if (!g?.img || g.censored) throw new Error("no image (or censored)");
      const buf = Buffer.from(await (await fetch(g.img)).arrayBuffer());
      writeFileSync(file, buf);
      const entry = {
        file: rel,
        width,
        height,
        seed: g.seed,
        steps: 4,
        prompt,
        model: `FLUX.1 [schnell] (black-forest-labs), Apache-2.0; served as ${g.model}`,
        source: `AI Horde (aihorde.net), anonymous request, community worker ${g.worker_name}`,
        retrieved_at: new Date().toISOString(),
        bytes: buf.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
        people: "AI-generated; depicts no real person",
      };
      const i = prov.findIndex((p) => p.file === rel);
      if (i >= 0) prov[i] = entry;
      else prov.push(entry);
      writeFileSync(provPath, JSON.stringify(prov, null, 2) + "\n");
      console.log(`ok ${rel} ${buf.length}b`);
      return;
    } catch (e) {
      console.log(`retry ${rel} ${attempt}: ${String(e).slice(0, 200)}`);
      await sleep(10000);
    }
  }
  console.log(`gave up ${rel}`);
}

const queue = IMAGE_JOBS.slice();
await Promise.all(
  Array.from({ length: 2 }, async () => {
    while (queue.length) await one(queue.shift());
  })
);
console.log("done");
