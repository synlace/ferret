## Agent skills

### Issue tracker

Issues and PRDs live in the repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage roles are mapped to standard canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

The repository uses a single-context layout. See `docs/agents/domain.md`.

## Git & Pull Request Workflow

- **Direct Pushes Blocked:** Direct pushes to the `main` branch are blocked by repository rulesets.
- **Workflow:** 
  1. Create a descriptive feature branch from `main`.
  2. Implement, test, and commit your changes locally.
  3. Push the feature branch to the remote origin.
  4. Create a Pull Request (PR) using `gh pr create` (even if `required_approving_review_count` is 0).
  5. Merge the PR into `main` using `gh pr merge`.
