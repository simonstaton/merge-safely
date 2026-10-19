# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue.

Include:

- What you found and where (package, file, version or commit).
- How to reproduce it, ideally with a minimal PR, policy or connection setup.
- What an attacker gains.

You should get an acknowledgement within a few working days. We will keep you updated as we investigate, agree a disclosure date with you, and credit you in the advisory unless you prefer otherwise.

## In scope

Anything that breaks the runner contract in [docs/security.md](docs/security.md), for example:

- A reviewer writing files, reaching the network, or running a command not in `runner.allowedCommands`.
- PR content (title, body, comments, paths, file contents, diff) being treated as instructions outside the delimited data blocks, or escaping them.
- A forged or inflated proof-of-work audit.
- A pass verdict overwriting an unresolved block, or a verdict attaching to the wrong head SHA.
- A pull request changing the policy that governs its own review (the policy is read from the base branch).
- A forged or replayed verdict: a check run, commit status, round-history comment or review marker that the gate accepts although its own identity did not write it.
- A connection secret appearing in a prompt, log, verdict, check run, PR review, error message or API response.
- Webhook signature bypass, or access to the App's setup page, admin API or stored connections without `SETUP_TOKEN`.
- Budget ceilings that can be bypassed.

## Out of scope

- Code that a policy-allowed command runs. Allowing commands executes PR code by design; see [docs/security.md](docs/security.md#what-allowedcommands-exposes).
- Check runs written by other workflows in the same repository when the gate runs as the Action with the default `GITHUB_TOKEN`; see [docs/security.md](docs/security.md#non-guarantees). Use the App and pin the check's source app.
- A model reaching a wrong verdict without any contract being broken. Report those as eval cases instead.
- Vulnerabilities in model providers or in GitHub.

## Supported versions

Merge Safely is pre-1.0. Fixes go into the latest release only.
