export class User {
  /**
   * Optional app username (if you later add auth / ZRR account, etc.)
   */
  username: string;

  firstname: string;
  lastname: string;

  /**
   * Optional email (if relevant in your deployment).
   */
  email: string;

  /**
   * Recommended: a stable unique ID for the teacher/learner.
   * In your context, this can be the phone number, matricule, or any internal identifier.
   *
   * Used server-side to consolidate exports by person.
   */
  learnerId?: string;
}
