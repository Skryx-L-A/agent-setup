# Career / Recruiting

LinkedIn.

## LinkedIn

```bash
# Fetch profile
mcporter call linkedin.get_person_profile linkedin_username="username" sections="experience,education"

# Search for people
mcporter call linkedin.search_people keywords="AI engineer" location="Shanghai"

# Fetch company profile
mcporter call linkedin.get_company_profile company_name="openai" sections="posts,jobs"

# Search jobs
mcporter call linkedin.search_jobs keywords="software engineer" location="Remote" max_pages=2
```

> **Login required**: before first use, run `uvx mcp-server-linkedin@latest --login` to save a valid login session.

### Fallback

If the MCP is unavailable, use Jina Reader instead:

```bash
curl -s "https://r.jina.ai/https://linkedin.com/in/username"
```
