import { computed, ref } from 'vue';

import type { User } from '@/types/user';
import { useStorage } from '@/composables/useStorage';

const DEFAULT_USER: User = {
  username: '',
  firstname: '',
  lastname: '',
  email: '',
  learnerId: '',
};

export function useUser() {
  const storageService = useStorage();

  const user = ref<User | null>(null);
  const userFetched = ref(false);

  async function fetchUser() {
    const storedUser = await storageService.getValue('user');

    if (storedUser) {
      try {
        user.value = { ...DEFAULT_USER, ...JSON.parse(storedUser) };
      } catch {
        user.value = { ...DEFAULT_USER };
      }
    } else {
      user.value = { ...DEFAULT_USER };
    }

    userFetched.value = true;
  }

  async function setUser(newUser: User) {
    user.value = { ...DEFAULT_USER, ...(user.value ?? {}), ...newUser };
    await storageService.setValue('user', JSON.stringify(user.value));
  }

  async function resetUser() {
    user.value = { ...DEFAULT_USER };
    await storageService.setValue('user', JSON.stringify(user.value));
  }

  // Initialization
  fetchUser();

  return {
    // State
    user,
    userFetched,

    // Getters
    getUser: computed(() => user.value),
    getUserFetched: computed(() => userFetched.value),

    // Actions
    fetchUser,
    setUser,
    resetUser,
  };
}
