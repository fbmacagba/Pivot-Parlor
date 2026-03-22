# Cloudflare Pages (Remix)

## Production vs preview

`wrangler pages deploy` targets **preview** unless `--branch` matches your project’s **production branch** in the Cloudflare dashboard (usually `main`).

- **Production** (serves `pivotparlor.com` when that domain is attached to this project’s production deployment):

  ```bash
  npm run deploy
  ```

  This runs `prepare-pages-deploy` and deploys `./.pages-dist` with `--branch=main`.

- **Preview** (branch alias URL only):

  ```bash
  npm run deploy:preview
  ```

If you deploy from a non-`main` git branch without `--branch=main`, you will see the new UI on a `*.pages.dev` preview URL but **not** on the custom domain.

## Bundle contents

Always deploy **`.pages-dist`** (static `build/client` + `functions/`), not `./build/client` alone, so Remix SSR and route actions stay in sync with assets.
