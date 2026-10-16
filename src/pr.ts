import { getOctokit } from '@actions/github';

export interface PrRequest {
  owner: string;
  repo: string;
  /** Commit the edits are based on (must be the tip of `base`). */
  baseSha: string;
  base: string;
  branch: string;
  files: Array<{ path: string; content: string }>;
  title: string;
  body: string;
}

export interface PrClient {
  defaultBranch(owner: string, repo: string): Promise<string>;
  openPullRequest(req: PrRequest): Promise<string>;
}

/** Opens a PR from a new branch using the Git data API. Never updates an existing ref. */
export function octokitPrClient(token: string): PrClient {
  const gh = getOctokit(token);
  return {
    async defaultBranch(owner, repo) {
      return (await gh.rest.repos.get({ owner, repo })).data.default_branch;
    },
    async openPullRequest(req) {
      if (req.branch === req.base) throw new Error('refusing to commit to the base branch');
      const { owner, repo } = req;
      const baseCommit = await gh.rest.git.getCommit({ owner, repo, commit_sha: req.baseSha });
      const tree = await gh.rest.git.createTree({
        owner,
        repo,
        base_tree: baseCommit.data.tree.sha,
        tree: req.files.map((f) => ({ path: f.path, mode: '100644' as const, type: 'blob' as const, content: f.content })),
      });
      const commit = await gh.rest.git.createCommit({
        owner,
        repo,
        message: req.title,
        tree: tree.data.sha,
        parents: [req.baseSha],
      });
      await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${req.branch}`, sha: commit.data.sha });
      const pr = await gh.rest.pulls.create({ owner, repo, head: req.branch, base: req.base, title: req.title, body: req.body });
      return pr.data.html_url;
    },
  };
}
