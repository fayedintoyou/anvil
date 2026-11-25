// anvil's slash commands, as Discord registers them. `npm run register` sends this list to Discord
// (scripts/register.ts), so it imports nothing that Node can't load on its own.

import { MAX_NAME, MAX_SKILL, PROFESSIONS } from '../src/core/types.ts';

const STRING = 3;
const INTEGER = 4;
const SUBCOMMAND = 1;

const character = (description: string) => ({
  name: 'character',
  description,
  type: STRING,
  required: true,
  autocomplete: true,
  min_length: 2,
  max_length: MAX_NAME,
});

const professionChoice = {
  name: 'profession',
  description: 'Which profession',
  type: STRING,
  required: true,
  choices: PROFESSIONS.map((p) => ({ name: p.name, value: p.id })),
};

const recipe = (description: string) => ({
  name: 'recipe',
  description,
  type: STRING,
  required: true,
  autocomplete: true,
});

export const COMMANDS = [
  {
    name: 'whocan',
    description: 'Who in the guild can craft something',
    options: [recipe('What you want made')],
  },
  {
    name: 'prof',
    description: 'Your characters’ professions',
    options: [
      {
        name: 'set',
        description: 'Set a character’s skill in a profession (adds the character if it’s new)',
        type: SUBCOMMAND,
        options: [
          character('Your character’s name'),
          professionChoice,
          { name: 'skill', description: `Skill level, 1 to ${MAX_SKILL}`, type: INTEGER, required: true, min_value: 1, max_value: MAX_SKILL },
        ],
      },
      {
        name: 'drop',
        description: 'Remove a profession from a character',
        type: SUBCOMMAND,
        options: [character('Your character’s name'), professionChoice],
      },
      {
        name: 'forget',
        description: 'Remove a character and everything logged for it',
        type: SUBCOMMAND,
        options: [character('Your character’s name')],
      },
    ],
  },
  {
    name: 'recipe',
    description: 'Recipes a skill level doesn’t cover: drops, vendor patterns, reputation, campsites',
    options: [
      {
        name: 'add',
        description: 'Log a recipe a character has learned',
        type: SUBCOMMAND,
        options: [character('Your character’s name'), recipe('The recipe')],
      },
      {
        name: 'remove',
        description: 'Take a logged recipe off a character',
        type: SUBCOMMAND,
        options: [character('Your character’s name'), recipe('The recipe')],
      },
    ],
  },
  {
    name: 'crafters',
    description: 'Everyone with a profession, highest skill first',
    options: [professionChoice],
  },
  {
    name: 'mine',
    description: 'What you’ve logged for your characters',
  },
  {
    name: 'anvil',
    description: 'The guild’s crafting page, and how to use anvil',
    options: [
      { name: 'title', description: 'Name the guild page (needs Manage Server)', type: STRING, required: false, max_length: 60 },
    ],
  },
];
