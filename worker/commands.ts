// anvil's slash commands, as Discord registers them. `npm run register` sends this list to Discord
// (scripts/register.ts), so it imports nothing that Node can't load on its own.

import { MAX_NAME, MAX_SKILL, PROFESSIONS } from '../src/core/types.ts';

const STRING = 3;
const INTEGER = 4;
const SUBCOMMAND = 1;
const BOOLEAN = 5;
/** Manage Server: commands with this are hidden from everyone else (the Worker checks again). */
const MANAGE_GUILD = String(1 << 5);

/** Left out, anvil uses the character this person last changed, so most people name it once. Discord
 *  wants optional options after the required ones, which is why it comes last where it's optional. */
const character = (required = false) => ({
  name: 'character',
  description: required ? 'Your character’s name' : 'Your character’s name; leave it out for the one you last changed',
  type: STRING,
  required,
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
          professionChoice,
          { name: 'skill', description: `Skill level, 1 to ${MAX_SKILL}`, type: INTEGER, required: true, min_value: 1, max_value: MAX_SKILL },
          character(),
        ],
      },
      {
        name: 'drop',
        description: 'Remove a profession from a character',
        type: SUBCOMMAND,
        options: [professionChoice, character()],
      },
      {
        name: 'forget',
        description: 'Remove a character and everything logged for it',
        type: SUBCOMMAND,
        options: [character(true)],
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
        options: [recipe('The recipe'), character()],
      },
      {
        name: 'remove',
        description: 'Take a logged recipe off a character',
        type: SUBCOMMAND,
        options: [recipe('The recipe'), character()],
      },
      {
        name: 'bulk',
        description: 'Paste a list of recipes, one per line, to log them all at once',
        type: SUBCOMMAND,
        options: [character()],
      },
      {
        name: 'edit',
        description: 'A private link to tick off a character’s recipes on the web',
        type: SUBCOMMAND,
        options: [character()],
      },
    ],
  },
  {
    name: 'want',
    description: 'Ask the guild for something made: pings the people who can craft it',
    options: [
      recipe('What you want made'),
      { name: 'note', description: 'Anything to add, like “I have the mats”', type: STRING, required: false, max_length: 200 },
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
    options: [
      {
        name: 'reminders',
        description: 'Whether anvil may message you when your entries go a month without an update',
        type: BOOLEAN,
        required: false,
      },
    ],
  },
  {
    name: 'cooldown',
    description: 'Mooncloth, transmutes, the Salt Shaker: when they’re ready again',
    options: [
      {
        name: 'used',
        description: 'You just used one: anvil messages you when it’s ready',
        type: SUBCOMMAND,
        options: [
          { name: 'cooldown', description: 'Which one', type: STRING, required: true, autocomplete: true },
          { name: 'hours_left', description: 'If it wasn’t just now: hours until it’s ready, as the game shows', type: INTEGER, required: false, min_value: 1, max_value: 120 },
          character(),
        ],
      },
      { name: 'list', description: 'Everyone’s cooldowns, and when they’re ready', type: SUBCOMMAND },
    ],
  },
  {
    name: 'board',
    description: 'Post the crafting board in this channel; anvil keeps it up to date (needs Manage Server)',
    default_member_permissions: MANAGE_GUILD,
    options: [{ name: 'stop', description: 'Take the board down instead', type: BOOLEAN, required: false }],
  },
  {
    name: 'anvil',
    description: 'The guild’s crafting page, and how to use anvil',
    options: [
      { name: 'title', description: 'Name the guild page (needs Manage Server)', type: STRING, required: false, max_length: 60 },
    ],
  },
];
