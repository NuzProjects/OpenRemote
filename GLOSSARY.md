# OpenRemote

A desktop console supervising local and cloud agent harnesses, their tools, and add-on plugins.

## Language

**Plugin**:
An installable package extending harnesses with tools, skills, or prompt commands, sourced from a marketplace, git repository, or local folder.
_Avoid_: Extension, add-on, package

**Marketplace**:
A repository or catalog endpoint listing discoverable plugins that can be fetched and installed.
_Avoid_: Store, registry, repo list

**Harness**:
An underlying agent CLI runtime (Claude Code, Codex, Grok, Pi, OpenCode, Antigravity) that OpenRemote drives.
_Avoid_: Engine, agent, backend

**Catalog**:
The cached aggregate list of discoverable plugins provided by all currently enabled marketplaces.
_Avoid_: Index, plugin database

**Power**:
A permission or capability a plugin declares and requires to execute, such as non-sandboxed command execution or network access.
_Avoid_: Permission, entitlement, scope
