# Cómo contribuir — Chat Asistente Psicológico

¡Gracias por tu interés en contribuir! Este documento describe el flujo de trabajo
obligatorio del repositorio. Por favor, léelo antes de abrir un *pull request*.

## Modelo de ramas (CRÍTICO)

El repositorio usa un flujo centralizado en `dev`. Respeta estrictamente lo siguiente:

- **TODO el trabajo ocurre en `dev`.** Nunca trabajes directamente sobre `main`.
- Desde `dev` se derivan ramas de trabajo:
  - `feat/*` — nuevas funcionalidades
  - `fix/*` — correcciones de bugs
  - `chore/*` — mantenimiento, dependencias, configuración
- Estas ramas se **mergean de vuelta a `dev`** (vía PR).
- El paso `dev → main` se hace **al final**, solo desde `dev`. **Nunca a `main` directo.**

```
main
  ↑ (solo al final, desde dev)
dev
  ├── feat/mi-feature
  ├── fix/mi-bug
  └── chore/mi-tarea
```

Si abrís un PR apuntando a `main`, será rechazado hasta que se redirija a `dev`.

## Proceso de Pull Request

1. Crea tu rama desde `dev` con el prefijo correspondiente (`feat/*`, `fix/*`, `chore/*`).
2. Asegúrate de que tu cambio tiene pruebas cuando aplica (ver sección de Tests).
3. Abre el PR **contra `dev`**.
4. El PR requiere:
   - Revisión de al menos un mantenedor.
   - **CI en verde** (typecheck + tests).
   - Mensajes de *commit* convencionales (`feat:`, `fix:`, `docs:`, `refactor:`).
   - **Sin línea `Co-Authored-By`** en los commits.
5. Usa las plantillas de *issue* (`.github/ISSUE_TEMPLATE/`) para reportar bugs o
   proponer features; facilitan la revisión.

## Tests

Antes de abrir un PR, ejecuta localmente:

```bash
pnpm -r typecheck
pnpm -r test
```

Las pruebas usan **Vitest**. El suite de `e2e` cubre rotación de claves, alertas,
purga, consentimiento, flujo y *takeover*. No merges con tests en rojo.

## Estilo de código (desde `AGENTS.md`)

Estas reglas son **duras**, no sugerencias, porque el proyecto maneja datos clínicos
sensibles:

- **TypeScript strict** en todos los archivos TS (`strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `isolatedModules`).
- **Sin `any`** sin justificación explícita (`// @ts-expect-error` con razón).
- **Sin `enum`**: usar objetos `as const` (ver `shared-types`).
- **Imports nombrados**, no `import * as X` cuando se puedan usar imports nombrados.
- **Manejo de errores**: sin bloques `catch` vacíos ni silenciosos.
- **Sin secretos hardcodeados** (API keys, tokens, passwords) en código o config.
- **Logging sin PII**: nunca logs de contenido de mensajes, datos clínicos ni *chunks*
  RAG crudos. Usa el redactor de PII de `telemetry`.
- Tipos de retorno explícitos en funciones exportadas; uniones discriminadas para
  máquinas de estado (alertas, riesgo, estados de chat).
- *Commits* convencionales y pequeños módulos enfocados (composición sobre herencia).

## Seguridad y cumplimiento

Cualquier cambio que toque consentimiento, cifrado, RBAC o el *coherence gate* debe
conservar las garantías del proyecto (ver `SECURITY.md` y `AGENTS.md`). Si tu cambio
puede afectar la privacidad o el cumplimiento, descríbelo claramente en el PR.

## Reportar bugs o proponer features

Usa las plantillas en [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). Para
vulnerabilidades de seguridad, **no** abras un issue público: sigue
[SECURITY.md](SECURITY.md).
