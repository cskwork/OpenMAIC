---
'@openmaic/storage': patch
'@openmaic/renderer': patch
'@openmaic/importer': patch
---

Depend on @openmaic/dsl through a caret range instead of an exact pin.

These packages declared `workspace:*`, which `pnpm publish` resolves to the exact dsl version in
the tree at publish time. Installing two of them therefore resolved two copies of the dsl —
`storage@0.1.0` pinned `0.5.0` while `renderer@0.0.3` and `importer@0.1.1` pinned `0.4.0` — and a
document produced against one copy was validated by the other copy's schema. They now declare
`workspace:^`, which publishes as a caret range and deduplicates.
