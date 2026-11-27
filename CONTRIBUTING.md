# Contribuir a Gentle Graph

Usa Node 24 o superior, Git y pnpm. El paquete se distribuye con cero dependencias npm declaradas. El host Gentle Shell proporciona Pi y TypeBox. Para verificar un clon independiente instala exclusivamente el entorno de desarrollo con el comando que usa CI:

```sh
npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund typescript@5.9.3 @types/node@24.13.3 typebox@1.1.38 @earendil-works/pi-coding-agent@1.6.0
```

## Añadir o mejorar un lenguaje

1. Implementa el contrato `LanguageAdapter` en `lib/gentle-graph/languages/<lang>.ts`. Conserva archivo, símbolo y líneas en cada referencia.
2. Registra sus extensiones y convenciones de tests en `languages/registry.ts`. Si procede, añade evidencia de arquitectura en `arch-detector.ts`.
3. Incluye un fixture realista en `tests/languages.test.ts` con contrato, implementación y consumidor. Comprueba que únicamente la implementación aparece en `implementations` y que `isTestFile` reconoce los tests del ecosistema.
4. Mantén separadas las consultas de guía, inspección e impacto y el parseo por lenguaje. Conserva la fachada pública en `index.ts`.

## Linux y Windows

Normaliza las rutas internas a `/` y manipúlalas con `path.posix`. Usa rutas nativas al acceder al sistema de archivos. Divide texto en líneas con `/\r?\n/`. Ejecuta procesos con argumentos separados y `windowsHide: true`. Envía las listas grandes de términos de Git por stdin con `git grep -F -f -`. Conserva las rutas relativas al worktree consultado.

## Antes de abrir la PR

- Ejecuta `pnpm typecheck` y `pnpm test`. Adjunta el resultado y el número de pruebas aprobadas.
- Ejecuta `node scripts/bench-jit.mjs 30000 --check`. Publica mediana y p95 de la guía en frío. El p95 debe ser inferior a 150 ms.
- Documenta el sistema probado localmente y los resultados de la matriz Linux/Windows cuando estén disponibles.
- Cualquier modificación de `package.json` requiere aprobación previa. Conserva cero dependencias npm y evita binarios externos adicionales.
- Para cambios del motor, herramientas o prompt, adjunta el informe del comparador A/B sobre el mismo commit, modelo y configuración de razonamiento. Ambos parches deben pasar la verificación. B debe consumir estrictamente menos tokens y terminar en menos tiempo en cada par. Una medición pendiente se declara pendiente. Consulta el procedimiento en el README.
