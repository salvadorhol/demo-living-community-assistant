import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {getApps, initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {defineSecret} from 'firebase-functions/params';
import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {warn} from 'firebase-functions/logger';

const accessPassword = defineSecret('APP_ACCESS_PASSWORD');
const adminPassword = defineSecret('ADMIN_ACCESS_PASSWORD');

function passwordExchange(admin: boolean) {
  return onCall(
    {
      region: 'us-central1',
      maxInstances: 2,
      secrets: admin ? [accessPassword, adminPassword] : [accessPassword],
    },
    async request => {
      const password: unknown = request.data?.password;
      if (
        typeof password !== 'string' ||
        password.length === 0 ||
        Buffer.byteLength(password, 'utf8') > 1024
      ) {
        throw new HttpsError('invalid-argument', 'Enter a valid password.');
      }
      const appSecret = accessPassword.value();
      const expected = admin ? adminPassword.value() : appSecret;
      if (!expected || !appSecret) {
        warn('app.access_unconfigured');
        throw new HttpsError(
          'unavailable',
          'Sign-in is unavailable. Please retry.'
        );
      }
      const hash = (value: string) =>
        createHash('sha256').update(value).digest();
      if (!timingSafeEqual(hash(password), hash(expected))) {
        warn('app.access_denied');
        throw new HttpsError('permission-denied', 'Incorrect password.');
      }
      try {
        const auth = getAuth(getApps()[0] ?? initializeApp());
        const {uid} = await auth.createUser({uid: randomUUID()});
        // Persist the claim so refreshed ID tokens retain authorization.
        await auth.setCustomUserClaims(uid, {
          appAccess: true,
          ...(admin ? {admin: true} : {}),
        });
        const customToken = await auth.createCustomToken(uid);
        return {customToken};
      } catch {
        // Do not log SDK errors: they may contain credentials or token details.
        warn('app.access_signing_failed');
        throw new HttpsError(
          'unavailable',
          'Sign-in is unavailable. Please retry.'
        );
      }
    }
  );
}

export const unlockApp = passwordExchange(false);
export const unlockAdmin = passwordExchange(true);
