# OpenCode Magic Context v0.33.0 — Golden Fixture Provenance

- Source repository: https://github.com/cortexkit/magic-context
- Release: v0.33.0
- Authority commit: `48ab531d8fa98af2f463db2e4d9f8ffdd63d765e`
- Generator version: 1
- Serializer version: iris-context-golden-v1

## Authoritative files (locked)

- `packages/plugin/src/hooks/magic-context/inject-compartments.ts`
- `packages/plugin/src/hooks/magic-context/compartment-trigger.ts`
- `packages/plugin/src/hooks/magic-context/derive-budgets.ts`
- `packages/plugin/src/hooks/magic-context/protected-tail-boundary.ts`
- `packages/plugin/src/hooks/magic-context/sentinel.ts`
- `packages/plugin/src/hooks/magic-context/m0m1-taxonomy.test.ts`
- `packages/plugin/src/hooks/magic-context/protected-tail-boundary.test.ts`

## Generated fixtures

| fixture | sha256 |
| --- | --- |
| `taxonomy-softplus-defer-identical.json` | `2f4801a293e206eafaa5cd57f6ab5770ceebfb2e30dd8c737b0c57b0d9fecffa` |
| `taxonomy-soft-exec-surfaces-m1.json` | `21ca9ac0c659fcf4f225fb666a8fbab43c9490950335d6ede826c015919a8880` |
| `taxonomy-hard-model-change.json` | `0e133fe5d0857f1778f8c9e4ab1bc13b3016e6fd88b6006448413ee86911bc14` |
| `taxonomy-hard-system-hash.json` | `b2b63ebe11789b4941a4ec3c8b874e3429dff07218a061d62e0af624d96eb279` |
| `taxonomy-empty-hard-signal-no-fold.json` | `bb215d552ff8d5c3df40f5f1bbe318a0be755ec9be406548035ad64b82c1453c` |
| `taxonomy-hard-ttl-idle-fold-once.json` | `a608b801ade7862b053da38e7c12046223337160637513f4c0c159658530d436` |
| `taxonomy-pressure-backstop-m1-cap.json` | `18bf4dd910e4b7b0a9f3268bd662325afd450c54b0aa7ee7cd512de3d10c7198` |
| `taxonomy-hard-markers-persist-restart.json` | `1027f119452eece4528ad8395ecf3dbac3d6d98706abab3691176e67afb451f1` |
| `protected-tail-suffix-walk.json` | `8bd07854dc9851fcd5a91d07a30712df392731a43a2dbccee1a9a2a9933c5839` |
| `protected-tail-n-clamp.json` | `9df7008586a80143defde852adc11db45c054476c038bc10d141cae620aed0b8` |
| `protected-tail-force-head-minimum.json` | `833bc360271501250b652acef2aead4ce85854c88b71440cdde362b5d77c8374` |
| `constants.json` | `4f7cbaf3cbdb814b5ac135ad4ee3da078fa1828fae05549b62157005eeb87e7a` |

## Guarantees

- Expected values are mechanically extracted from the locked released authority only; Iris never self-certifies.
- Regeneration requires the local authority checkout at HEAD `48ab531d…` (see `scripts/context-golden/generate.ts`).
- Committed fixtures remain runnable offline.
- Memory Mural / experimental.mural is forbidden and the generator fails if detected.
