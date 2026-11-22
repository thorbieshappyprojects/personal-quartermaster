# Personal Quartermaster

Self-hosted household inventory with an AI layer: what the household owns, where it is, what it cost and what is running low, filled from purchase-history imports, receipts and quick captures.

- Product and architecture spec: [SPEC.md](SPEC.md)
- Development rules: [CLAUDE.md](CLAUDE.md)
- Operator docs: [docs/](docs/)

## Development

Requires Node.js 22, pnpm and Docker.

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## Licence

MIT, see [LICENSE](LICENSE).
