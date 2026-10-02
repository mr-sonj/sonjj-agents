# Security Policy

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in Sonjj Agents (a fork of Craft Agents), please report it responsibly.

### How to Report

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, report it privately through [GitHub Security Advisories](https://github.com/mr-sonj/sonjj-agents/security/advisories/new).
If the issue also affects upstream Craft Agents, please report it to Craft Docs at **security@craft.do** as well.

Include the following information:
- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fixes (optional)

### What to Expect

This fork is maintained by one person on a best-effort basis. Reports are acknowledged and assessed
as soon as possible; fixes that belong upstream follow Craft Agents' own timeline.

### Scope

This policy applies to:
- The Sonjj Agents desktop application and server builds
- The [mr-sonj/sonjj-agents](https://github.com/mr-sonj/sonjj-agents) repository

### Out of Scope

- Third-party dependencies (report to their maintainers)
- Social engineering attacks
- Denial of service attacks

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| < Latest | :x:               |

We only provide security updates for the latest version. Please keep your installation up to date.

## Security Best Practices

When using Sonjj Agents:

1. **Keep credentials secure**: Never commit `.env` files or credentials
2. **Use environment variables**: Store secrets in environment variables
3. **Review permissions**: Be cautious with "Execute" permission mode
4. **Update regularly**: Keep the application updated

## Acknowledgments

We appreciate responsible disclosure and will acknowledge security researchers who report valid vulnerabilities (with their permission).
