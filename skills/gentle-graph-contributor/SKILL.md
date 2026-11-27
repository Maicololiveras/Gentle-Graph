---
name: gentle-graph-contributor
description: Preparar cambios de Gentle Graph para revisión, incluidos adaptadores, consultas, contratos de herramientas y rendimiento.
---

Lee CONTRIBUTING.md. Mantén la fachada pública en index.ts y la lógica de cada consulta en query-guide, query-inspect y query-impact. Sitúa los adaptadores en languages/. Conserva cero dependencias npm y evita añadir binarios externos.

Respeta los presupuestos de salida de 2400 caracteres para guía ordinaria como máximo, 3000 para inspección o guía con snippets y 2000 para impacto. Aplica los límites más estrictos de cada modalidad. Mantén GRAPH_PROMPT_HINT estático dentro del presupuesto aproximado de 24 tokens.

Incluye en el resumen de la PR la salida de pnpm typecheck, el conteo de pnpm test, el p95 del benchmark de 30.000 archivos y el estado de Linux y Windows. Identifica qué plataforma verificaste localmente. Para cambios en motor, herramientas o prompt incluye también el resultado A/B de tokens y tiempo con calidad equivalente.
