# Security policy

## Reporting a vulnerability

Do not publish passwords, keys, or exploitable details in a public issue. Use
the repository's private security advisory channel when it is available, or
contact the maintainer privately first.

## Automated protection

- GitHub Secret Scanning and push protection block recognized secrets before
  they reach the repository.
- CodeQL analyzes JavaScript and TypeScript on pull requests, `main`, and a
  weekly schedule.
- Dependabot checks npm, Docker, and GitHub Actions dependencies weekly.

## Secure Code Game

The free [GitHub Secure Code Game](https://github.com/skills/secure-code-game)
is available for contributors who want hands-on secure-coding practice. It is
a separate interactive GitHub Skills course, not a dependency of the website.
