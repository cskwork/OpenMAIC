'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/hooks/use-i18n';
import { LockIcon } from 'lucide-react';

interface AccessCodeModalProps {
  open: boolean;
  onSuccess: () => void;
}

export function AccessCodeModal({ open, onSuccess }: AccessCodeModalProps) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/access-code/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      if (res.ok) {
        onSuccess();
      } else {
        setError(t('accessCode.error'));
      }
    } catch {
      setError(t('accessCode.error'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-[400px]">
        <DialogHeader>
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <LockIcon className="h-6 w-6 text-muted-foreground" />
          </div>
          <DialogTitle className="text-center">{t('accessCode.title')}</DialogTitle>
          <DialogDescription className="text-center sr-only">
            {t('accessCode.title')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            type="password"
            placeholder={t('accessCode.placeholder')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoFocus
          />
          {error && <p className="text-sm text-destructive text-center">{error}</p>}
          <Button type="submit" disabled={loading || !code}>
            {loading ? t('common.loading') : t('accessCode.submit')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
