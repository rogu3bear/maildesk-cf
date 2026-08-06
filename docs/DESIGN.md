# Design System

## Design Direction

**Concept: Editorial edge control room.** The site combines the trust and restraint of a technical operations manual with the spatial clarity of a high-end communications desk. It should feel tactile and calm, never like a neon observability dashboard or generic SaaS starter.

**Signature moment:** the hero and architecture pages share a live-looking “chain of custody” rail. A small message pulse moves from Edge to Policy to Store to Desk to Send while each stage exposes its evidence class. The motion is CSS-only, decorative, and removed under `prefers-reduced-motion`.

**Composition:** asymmetric hero, strong editorial type, hairline route rails, a grounded split-pane desk, and large areas of quiet negative space. Dense operational data stays inside bounded panels.

**Surface grammar:** public architecture boundaries use square, ruled cells to read as fixed system contracts. Interactive operator surfaces use rounded panels to read as live work areas. Both families share the same paper, ink, line, spacing, and type tokens; the shape difference is semantic, not a second design system.

**Palette:** warm paper and carbon with copper for action, mineral teal for verified state, and muted amber/red for attention. No purple-blue gradient, pure black, or status-by-color alone.

**Cursor:** native.

## Typography

- **Display:** local editorial serif stack (`Iowan Old Style`, `Palatino Linotype`, `Book Antiqua`, `Georgia`, serif).
- **Body/UI:** system sans stack (`Inter` when installed, `ui-sans-serif`, `system-ui`, sans-serif).
- **Data:** `ui-monospace`, `SFMono-Regular`, `Menlo`, monospace.
- **Body size:** `clamp(1rem, 0.97rem + 0.15vw, 1.1rem)`.
- **Measure:** 45–72ch; long-form copy max 64ch.
- **Line height:** 1.55–1.7 body; 0.98–1.12 display; 1.25 controls.
- **Loading strategy:** system/local stacks only for first release; zero external font payload and no layout shift.

## Tokens

| Token | Value |
| --- | --- |
| `--paper` | `#f3efe5` |
| `--paper-bright` | `#fbf8f0` |
| `--ink` | `#171914` |
| `--ink-soft` | `#3f443b` |
| `--line` | `#c9c4b6` |
| `--copper` | `#b9522b` |
| `--copper-dark` | `#7e321b` |
| `--mineral` | `#0f7068` |
| `--amber` | `#a86d18` |
| `--danger` | `#9b3333` |
| spacing scale | 4, 8, 12, 16, 24, 32, 48, 64, 96 |
| radius scale | 6, 12, 20, pill |
| shadow 1 | subtle two-layer panel lift |
| shadow 2 | focused modal/detail elevation |

## Components

| Component | Decision | Status |
| --- | --- | --- |
| Primary action | Copper field, high contrast, one per section | Accepted provisional |
| Secondary link | Text/underline with directional glyph | Accepted provisional |
| Evidence chip | Icon/shape + label + freshness; never color alone | Accepted provisional |
| Thread row | Sender/subject first, route and state second | Accepted provisional |
| Identity gate | From identity visible adjacent to queue action | Accepted provisional |
| Audit event | Timeline with actor, action, evidence class, timestamp | Accepted provisional |
| Empty/error state | Explain current truth and next safe action | Accepted provisional |

## UX Audit Findings

| Issue | Heuristic | Severity (0-4) | Fix | Status |
| --- | --- | --- | --- | --- |
| “Ready” could hide proof scope | Visibility of system status | 4 | Use four explicit readiness planes | Designed |
| Queue action could imply send completion | Match with real world | 4 | Label queued, attempted, delivered separately | Designed |
| Identity selector could look cosmetic | Error prevention | 4 | Server-authorize and explain selection | Designed |
| Wide desk may collapse poorly | Flexibility and accessibility | 3 | Mobile stack and bounded sticky regions | Pending render |
| Route rail motion may distract | User control | 2 | Reduced-motion removal and no semantic dependency | Designed |
| Single authorized identity rendered as a preference | Norman gulf of execution | 4 | Render the server-authorized identity as read-only policy output | Implemented; moderated validation pending |
| Public architecture promised outbound retries the consumer does not perform | Visibility of system status | 4 | Say outbound attempts and document deliberate recovery semantics | Implemented; recovery design remains P0 |
| Loading and failure copy exposed implementation language | Match with the real world | 3 | Name the operator task and immediate recovery action | Implemented; comprehension test pending |
| Reply subject/body constraints surfaced too late | Error prevention | 3 | Add browser constraints plus what/why/how local feedback | Implemented; usability test pending |
| Runtime instance row could imply all bindings were healthy | Visibility of system status | 3 | Limit the claim to the desk database actually exercised by the page | Implemented; live readiness integration pending |
| Thread links fell through to the 404 route | Match between system and real world | 4 | Define `desk`, `thread`, and `:id` as distinct Leptos path segments | Fixed after rendered route pass |
| Thread failure exposed Leptos server-function terminology | Match with the real world | 3 | Strip the framework prefix and preserve the actionable server message | Fixed after rendered route pass |

## Microinteraction Inventory

| Interaction | Trigger/Rules/Feedback/Loops | Fix | Status |
| --- | --- | --- | --- |
| Route pulse | Page load; transform/opacity only; disabled for reduced motion | CSS animation | Planned |
| Thread selection | Click/keyboard; immediate selected state; URL updates | Leptos Router link | Planned |
| Readiness refresh | Explicit action; loading label; timestamp updates | Server action/resource | Planned |
| Reply queue | Disable while pending; return queued reference or recoverable error | Server action | Planned |
| Reply identity | Thread load / route policy / immutable visible identity / remains fixed for this server contract | Replace single-option selector with read-only output and explanation | Implemented |
| Reply validation | Submit / require subject and body / inline what-to-do feedback / repeats until valid | Native constraints plus tested local copy | Implemented |
| Desk refresh | Button / refetch operator-scoped state / loading or failure state / explicit repeat | Rename action to the operator task | Implemented; perceived-latency test pending |

## Performance Baseline

Field INP, LCP, and CLS measurements do not exist. Release targets are INP under
200 ms, LCP under 2.5 s, and CLS under 0.1 on the public home, architecture,
desk-preview, and protected thread routes. Static build size and rendered
desktop/mobile review are supporting evidence only; they do not substitute for
field metrics.
