# VOID AI Launcher Windows Porting Guide

This document outlines the architectural differences, dependencies, and code modifications required to port **VOID AI Launcher** (currently optimized for Linux/macOS) to run natively on **Windows (Command Prompt, PowerShell, Windows Terminal)**.

---

## 1. Key Porting Obstacles & Solutions

### 1.1 Shell Execution & Command Launching
*   **The Issue**: The codebase spawns subshells using `bash` or `/bin/bash` with Unix-specific flags like `-lc` (interactive/login shell) or `-i`.
    *   *Reference*: `lib/runner.js` uses `process.env.SHELL || '/bin/bash'` and `spawnSync(shell, ['-lc', commandLine])`.
    *   *Reference*: `lib/extTokens.js` runs `spawnSync('bash', ['-c', runCmd])`.
*   **The Solution**:
    *   Perform a platform check: `const isWin = process.platform === 'win32';`.
    *   On Windows, resolve the default shell to `cmd.exe` or `powershell.exe` (via `process.env.COMSPEC` or `powershell`).
    *   Change arguments from `['-lc', cmd]` to `['/c', cmd]` for `cmd.exe` or `['-Command', cmd]` for PowerShell.

### 1.2 Session Management (`tmux` Dependency)
*   **The Issue**: The multi-tab wrapper layout (`lib/wrapper.js`) and sessions menu (`lib/sessions.js`) rely heavily on `tmux` commands (`tmux attach-session`, `tmux list-sessions`, etc.), which are unavailable natively on Windows.
*   **The Solution**:
    *   **Fallback to Plain Spawn**: When `tmux` is not detected (always true on native Windows unless using WSL/MSYS2), disable the tmux features and default to single-session plain spawning (`spawnSync`).
    *   **WSL (Windows Subsystem for Linux) Integration**: If the user has WSL installed, we can detect it and run the launcher commands inside WSL via `wsl tmux ...` to maintain full session support.
    *   **Platform Detection Flag**: Guard all tmux check calls:
        ```javascript
        const hasTmux = !isWin && spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
        ```

### 1.3 Native Module Compilation (`node-pty`)
*   **The Issue**: The framed terminal wrapper uses `node-pty` to capture and stream pseudo-terminal outputs. On Windows, `node-pty` compiles native C++ bindings for the Windows ConPTY API.
*   **The Solution**:
    *   Instruct users to install development tools before package installation:
        ```powershell
        npm install --global windows-build-tools
        # Or install C++ CMake tools via Visual Studio Installer
        ```
    *   The `pty.spawn()` function in `node-pty` automatically handles ConPTY on Windows, but the shell executable argument must be changed from `bash` to `powershell.exe` or `cmd.exe`.

### 1.4 Path Separators & File Operations
*   **The Issue**: Hardcoded Unix path separators (`/`) are used in config directory resolution and storage scripts.
*   **The Solution**:
    *   Import and use Node's native `path` module:
        ```javascript
        const path = require('path');
        // Replace: `${configDir}/${sessionName}`
        // With: path.join(configDir, sessionName)
        ```

### 1.5 Default Text Editor
*   **The Issue**: Direct editing of `config.yml` defaults to `vi`.
    *   *Reference*: `launcher.js:L259` runs `spawnSync(process.env.EDITOR || 'vi', ...)` which freezes/fails on Windows if `vi` is missing.
*   **The Solution**:
    *   On Windows, fall back to `notepad` or `notepad.exe`:
        ```javascript
        const defaultEditor = isWin ? 'notepad' : 'vi';
        const editor = process.env.EDITOR || defaultEditor;
        spawnSync(editor, [configPath], { stdio: 'inherit' });
        ```

---

## 2. Step-by-Step Code Modifications

### Step 2.1: Implement OS Helper in `lib/ui.js` or `launcher.js`
Create a centralized platform-check module or variable:
```javascript
const isWin = process.platform === 'win32';
```

### Step 2.2: Refactor `lib/runner.js` (Shell Invocation)
Modify the `runCommandLine` and `runHostShell` functions:
```javascript
const isWin = process.platform === 'win32';

function getHostShell() {
  if (isWin) return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

function getShellArgs(shell, commandLine) {
  if (isWin) {
    const isPowerShell = shell.toLowerCase().includes('powershell');
    return isPowerShell ? ['-Command', commandLine] : ['/c', commandLine];
  }
  return ['-lc', commandLine];
}

// Inside runCommandLine:
const shell = getHostShell();
const args = getShellArgs(shell, commandLine);
const result = spawnSync(shell, args, { env, stdio: 'inherit', shell: isWin });
```

### Step 2.3: Refactor `lib/sessions.js` (TMUX Safe Guards)
Ensure that session management returns empty/disabled gracefully on Windows:
```javascript
const isWin = process.platform === 'win32';

function checkTmux() {
  if (isWin) return false; // Native Windows has no tmux
  try {
    return spawnSync('which', ['tmux'], { encoding: 'utf8' }).status === 0;
  } catch (e) {
    return false;
  }
}
```

### Step 2.4: Update Configuration Editor in `launcher.js`
Change the editor invocation at line 258:
```javascript
const isWin = process.platform === 'win32';
const defaultEditor = isWin ? 'notepad' : 'vi';
spawnSync(process.env.EDITOR || defaultEditor, [configPath], { stdio: 'inherit' });
```

---

## 3. Installation Guide for Windows Users

To install and run **VOID AI Launcher** on Windows:

1.  **Install Node.js**: Ensure Node.js (v16+) is installed.
2.  **Install Build Tools** (Required for compilation of `node-pty`):
    *   Open PowerShell as Administrator and run:
        ```powershell
        npm install --global --production windows-build-tools
        ```
    *   Alternatively, install Visual Studio Community and check "Desktop development with C++".
3.  **Clone & Install Dependencies**:
    ```cmd
    git clone <repository_url>
    cd ai-launcher
    npm install
    ```
4.  **Register Global Command**:
    To run the `void` command globally, run:
    ```cmd
    npm link
    ```
    *(Note: On Windows PowerShell, you might need to enable script execution: `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`)*.
