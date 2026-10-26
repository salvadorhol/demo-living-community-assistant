import {run} from './process.mjs';

// Match the working login services without allUsers IAM bindings, which domain
// restricted sharing can prohibit. Firebase verifies the ID token and
// requireReviewAdmin checks the admin claim inside each of these callables.
export const reviewCallables = [
  'listReviewCalls',
  'getReviewCall',
  'getReviewAudio',
  'generateCallReview',
  'deleteCall',
];

export function configureReviewInvokers({projectId, root, execute = run}) {
  for (const name of reviewCallables) {
    execute(
      'gcloud',
      [
        'run',
        'services',
        'update',
        name.toLowerCase(),
        '--no-invoker-iam-check',
        '--region=us-central1',
        `--project=${projectId}`,
        '--quiet',
      ],
      {cwd: root}
    );
  }
}
