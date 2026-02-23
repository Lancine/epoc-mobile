import { alertController } from '@ionic/vue';
import { useI18n } from 'vue-i18n';

import { useUser } from '@/composables/useUser';
import type { User } from '@/types/user';

export async function handleSetUser(setUserFetched = true) {
  const userService = useUser();
  const { t } = useI18n();

  // Ensure we have current values (to pre-fill inputs)
  await userService.fetchUser();
  const current = (userService.getUser.value ?? {
    username: '',
    firstname: '',
    lastname: '',
    email: '',
    learnerId: '',
  }) as User;

  // i18n fallback for the new placeholder (in case you didn't add the translation key yet)
  const learnerIdPlaceholderKey = 'SETTINGS_PAGE.SET_USER.LEARNERID_PLACEHOLDER';
  const learnerIdPlaceholder = (() => {
    const translated = t(learnerIdPlaceholderKey);
    return translated === learnerIdPlaceholderKey ? 'Téléphone / ID' : translated;
  })();

  const alert = await alertController.create({
    header: t('SETTINGS_PAGE.SET_USER.INFO'),
    message: t('SETTINGS_PAGE.SET_USER.MESSAGE'),
    inputs: [
      {
        name: 'firstname',
        placeholder: t('SETTINGS_PAGE.SET_USER.FIRSTNAME_PLACEHOLDER'),
        value: current.firstname ?? '',
      },
      {
        name: 'lastname',
        placeholder: t('SETTINGS_PAGE.SET_USER.LASTNAME_PLACEHOLDER'),
        value: current.lastname ?? '',
      },
      {
        name: 'learnerId',
        type: 'tel',
        placeholder: learnerIdPlaceholder,
        value: (current as any).learnerId ?? '',
      },
    ],
    buttons: [
      { text: t('CANCEL'), role: 'cancel' },
      {
        text: t('OK'),
        handler: async (data: any) => {
          const updated: User = {
            ...current,
            firstname: (data.firstname ?? '').trim(),
            lastname: (data.lastname ?? '').trim(),
            learnerId: (data.learnerId ?? '').trim(),
          };

          await userService.setUser(updated);
          await userService.fetchUser();

          if (setUserFetched) {
            userService.userFetched.value = true;
          }
        },
      },
    ],
  });

  await alert.present();
}
