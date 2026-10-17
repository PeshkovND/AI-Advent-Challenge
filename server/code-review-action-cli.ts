import { ActionError, runReviewAction } from './code-review-action'

runReviewAction().then((result) => {
  console.log(`AI review: ${result.status}. Reports: ${result.directory}`)
  if (result.failed) process.exitCode = 1
}).catch((error) => {
  console.error(error instanceof ActionError ? error.message : 'AI review failed. Check repository-path, base/head refs, model availability and report artifacts.')
  process.exitCode = 1
})
