# nax docs

The documentation site for nax and `nax-agent-runner-sdk`.

## Local development

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
```

## Deploy

The repository's root `netlify.toml` builds this directory with
`@netlify/plugin-nextjs`. Push a branch for a Netlify deploy preview; merges to
`master` update the production docs site.
