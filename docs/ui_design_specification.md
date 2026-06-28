# VOID Terminal UI Design Specification

This document defines the layout structure, terminology, and naming conventions for the **VOID AI Launcher Terminal UI** (updated to **Option A: Borderless Status Bar Layout**).

---

## 1. Visual Layout Map

Below is the conceptual layout map of the terminal interface, showing the hierarchy of panels and status bars as rendered in true-color ANSI.

```text
■■■■ [A] Top Status Bar (상단 상태 바) ■■■■■■■■■■■■■■■■■■■■■■■■■■ [A-2] Frame Time ▀▀
                                                                                
    ┌── [B-1] Logo Panel (좌측 로고 패널) ───┐   ┌── [B-2] Links Panel (우측 링크 패널) ──┐
    │                                        │   │                                       │
    │  [B-1-a] VOID Logo (아스키 로고)       │   │  [B-2-a] Links Header (헤더)           │
    │  [B-1-b] Subtitle (서브타이틀)         │   │  [B-2-b] Links List (링크 링크 목록)   │
    │  [B-1-c] Workspace Path (워크스페이스) │   │                                       │
    │                                        │   │                                       │
    └────────────────────────────────────────┘   └───────────────────────────────────────┘
                                                                                
    ┌── [C] Main Body Panel (메인 바디 패널 / 메뉴 패널) ────────────────────────┐
    │                                                                           │
    │  [C-1] Menu Item Rows (메뉴 아이템 로우)                                  │
    │    - [C-1-a] Menu Key Bindings (단축키 괄호)                               │
    │    - [C-1-b] Menu Option Carousel (좌우 선택 옵션 캐러셀)                 │
    │                                                                           │
    └───────────────────────────────────────────────────────────────────────────┘
                                                                                
    [D] History Footer (이력 푸터)                                               
    [E] Guide/Shortcut Footer (안내 푸터)                                        
                                                                                
■■■■ [F] Bottom Status Bar (하단 상태 바) ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■ ▀▀
```

---

## 2. Component Dictionary (구성요소 명칭 및 정의)

### A. Status Bars (상하단 바 영역)
*   **[A] Top Status Bar (상단 상태 바)**
    *   **Description**: The full-width colored bar at the very top of the screen containing screen identity and current time.
    *   **Korean Name**: 상단 상태 바 (또는 상단 프레임 바)
    *   **[A-1] Status Brand Label (좌측 브랜드 라벨)**:
        *   Renders `" VOID >_  [Icon][ScreenName] "` (e.g., `VOID >_ 🏠 HOME`, `VOID >_ ⚙️ 설정 및 이력`).
        *   The Icon is automatically prepended based on the category of the screen title (e.g., ⚙️, 🔑, 📜) while preserving pre-existing emojis.
        *   `VOID` is rendered in **Bold** and animated with **Shiny Text (Shimmer)**.
    *   **[A-2] Status Time Indicator (우측 시간 표시기)**:
        *   Renders the current time (`HH:MM:SS`) on the right side of the status bar.
*   **[F] Bottom Status Bar (하단 상태 바)**
    *   **Description**: A full-width solid bar at the very bottom of the screen displaying version details and exit key commands.
    *   **Korean Name**: 하단 상태 바 (또는 하단 프레임 바)
    *   **Content**: Renders `"  VOID // ai-launcher v2.0.0  ·  Press Ctrl+C to exit"`.

### B. Top Content Area (상단 분할 영역)
*   *Note: Only rendered on larger terminals (width >= 88 cols, height >= 24 rows).*
*   **[B-1] Logo Panel (좌측 로고 패널)**
    *   **Description**: The box on the left inside the top content region.
    *   **Korean Name**: 상단 좌측 로고 패널
    *   **[B-1-a] VOID Logo (아스키 로고)**: The block-character 3D ASCII art representing `VOID`.
    *   **[B-1-b] Logo Subtitle (로고 서브타이틀)**: The string `// ai-launcher` accompanied by a static clock.
    *   **[B-1-c] Workspace Path Label (워크스페이스 경로)**: Shows the current active repository path.
*   **[B-2] Links Panel (우측 링크 패널)**
    *   **Description**: The box on the right inside the top content region displaying bookmarks.
    *   **Korean Name**: 상단 우측 링크 패널
    *   **[B-2-a] Links Header (링크 헤더)**: The border header with label `Links`.
    *   **[B-2-b] Links List (외부 링크 목록)**: Bookmark targets (Wiki, AdminConsole, Notion, etc.).

### C. Lower Main Area (하단 영역)
*   **[C] Main Body Panel (메인 바디 패널 / 메뉴 패널)**
    *   **Description**: The central container hosting key actions and configurations.
    *   **Korean Name**: 메인 바디 패널 (또는 하단 메뉴 패널)
    *   **[C-1] Menu Item Rows (메뉴 아이템 로우)**: Individual command slots.
        *   **[C-1-a] Menu Key Bindings (단축키)**: The leading bracketed keys (e.g., `[q]`, `[1]`, `[2]`).
        *   **[C-1-b] Option Carousel (옵션 캐러셀)**: Left/right selectable options inline (e.g., `◀ claude ▶`).
*   **[D] History Footer (이력 푸터)**
    *   **Description**: The line at the bottom showing recent execution status (e.g., `최근 실행: claude · 2s ago`).
    *   **Korean Name**: 실행 이력 푸터
*   **[E] Guide/Shortcut Footer (안내 푸터)**
    *   **Description**: The help text line showing key bindings (e.g., `↑↓ 이동   ←→ 옵션 변경   Enter 실행`).
    *   **Korean Name**: 하단 조작 안내선

---

## 3. Styling & Color Tokens (디자인 및 애니메이션 토큰)

| Component | Default Theme Style | Animation State | Code Reference |
| :--- | :--- | :--- | :--- |
| **VOID** Brand text | Bold, High contrast | Shiny Text (Shimmer Sweep) | [ui.js:L241-263](file:///home/doil/workspace/w_dev/ai-launcher/lib/ui.js#L241-L263) |
| **Top Status Bar** | `palette.signal` background | Shimmers **only** inside `VOID` | [ui.js:L289](file:///home/doil/workspace/w_dev/ai-launcher/lib/ui.js#L289) |
| **Bottom Status Bar** | `palette.signal` background | Static | [ui.js:L298-301](file:///home/doil/workspace/w_dev/ai-launcher/lib/ui.js#L298-L301) |
| **ASCII Logo** | `palette.signal` foreground | Static | [ui.js:L135-180](file:///home/doil/workspace/w_dev/ai-launcher/lib/ui.js#L135-L180) |
| **Main Menu Items** | Highlight: `onSignal + signalBg` | Interactive hover cursor | [ui.js:L162-207](file:///home/doil/workspace/w_dev/ai-launcher/lib/ui.js#L162-L207) |

---

> [!NOTE]
> All measurements (`IW`, `W` widths) are dynamic, adapting to the user terminal's columns. Side borders are completely omitted to provide an open, modern aesthetic, while the top and bottom status bars form a solid unified frame.
