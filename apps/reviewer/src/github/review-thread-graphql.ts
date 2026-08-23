export const reviewThreadsQuery = `
  query LeverframeReviewThreads($owner: String!, $repository: String!, $pullRequestNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repository) {
      pullRequest(number: $pullRequestNumber) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            id
            isResolved
            viewerCanResolve
            comments(first: 100) {
              nodes {
                id
                body
                pullRequestReview { fullDatabaseId }
              }
            }
          }
          pageInfo { endCursor hasNextPage }
        }
      }
    }
  }
`;

export const reviewThreadQuery = `
  query LeverframeReviewThread($threadId: ID!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        id
        isResolved
        viewerCanResolve
        comments(first: 100, after: $after) {
          nodes { id body }
          pageInfo { endCursor hasNextPage }
        }
      }
    }
  }
`;

export const addReviewThreadReplyMutation = `
  mutation LeverframeAddReviewThreadReply($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment { id }
    }
  }
`;

export const resolveReviewThreadMutation = `
  mutation LeverframeResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;
