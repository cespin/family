import { useEffect, useState } from 'react';
import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/auth/AuthLayout.jsx';
import { Button, MonkeyBadge } from '../components/ui';
import { useSession } from '../hooks/useSession.js';

export function SignInScreen() {
  const { t } = useTranslation();
  const { signIn } = useSession();
  const [phase, setPhase] = useState('ready');

  // Coming back from Google with the browser's back button restores this page as it was left.
  useEffect(() => {
    function handlePageShow(event) {
      if (event.persisted) setPhase('ready');
    }
    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  async function handleSignIn() {
    setPhase('connecting');
    try {
      await signIn();
    } catch {
      setPhase('failed');
    }
  }

  const buttonLabels = {
    ready: t('auth:signIn.button'),
    connecting: t('auth:signIn.connecting'),
    failed: t('auth:signIn.retry'),
  };

  return (
    <AuthLayout>
      <div className="fa-auth__heading">
        <h2 className="fa-text-heading">
          {t('auth:signIn.title', { appName: t('common:appName') })}
        </h2>
        <p className="fa-text-body fa-text-muted">{t('auth:signIn.subtitle')}</p>
      </div>
      {phase === 'failed' && (
        <div className="fa-auth__alert" role="alert">
          <MonkeyBadge kind="oops">{t('auth:signIn.errorBadge')}</MonkeyBadge>
          <p className="fa-text-body">{t('auth:signIn.errorBody')}</p>
        </div>
      )}
      <Button
        variant="secondary"
        size="large"
        block
        icon={LogIn}
        disabled={phase === 'connecting'}
        onClick={handleSignIn}
      >
        {buttonLabels[phase]}
      </Button>
      <p className="fa-text-caption fa-text-muted">{t('auth:signIn.invited')}</p>
    </AuthLayout>
  );
}
