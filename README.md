# Launch80 tasks

Work from the projects of Launch80 members that someone else can take on. If you have more work than time, post it
here. If you have time, take something.

**[See the board](https://github.com/users/Code000-211/projects/3)** · Talk about tasks on the Launch80 Discord server.

## How it works

```
Draft ──/ready──▶ Ready ──/take──▶ In progress ──/review──▶ In review ──/done──▶ Done
                    ▲                   │
                    └──────/drop────────┘
```

Everything is done with commands: write one as the first line of a comment on a task. You need a GitHub account, but no
access to this repository.

### Posting a task

1. [Open a new task](../../issues/new/choose) and fill in the form. It starts as a **draft**.
2. Check that someone who does not know your project could start from it.
3. Comment `/ready`. The task goes to **Ready** and is announced on Discord.

Only you, the person who posted the task, can mark it ready and mark it done.

### Taking a task

1. Find one in the **Ready** column of the board.
2. Comment `/take`. You are assigned and the task goes to **In progress**.
3. Do the work in the task's project, and talk to the person who posted it on Discord.
4. When your pull request (or other result) is up, comment `/review <link>`.
5. The person who posted the task checks it and comments `/done`.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/ready` | Poster | Offers the task: Draft → Ready |
| `/draft` | Poster | Takes it back to Draft (only while nobody has it) |
| `/take` | Anyone | Takes the task: Ready → In progress, assigns you |
| `/drop` | Taker or poster | Gives the task back: → Ready |
| `/review <link>` | Taker | Says the work is ready to look at: In progress → In review |
| `/done` | Poster | Closes the task: → Done |
| `/thread <link>` | Poster or taker | Links the Discord thread on the board |
| `/help` | Anyone | Lists the commands |

Moderators can do everything the poster can.

## Rules

- **At most 2 tasks at a time** in progress or in review per person.
- **Leave a short update on the task at least every 7 days** while it is in progress. After 5 days without one you get a
  reminder, after 7 days the task goes back to Ready so someone else can take it.
- Discussion happens on Discord. The task on GitHub is the record: what is to be done, who has it, and where it stands.

## For maintainers

The workflows in [`.github/workflows`](.github/workflows) carry out the commands. Settings such as the board, the
moderators and the limits are in [`.github/tasks.json`](.github/tasks.json).

They need two repository secrets:

- `BOARD_TOKEN`: a classic personal access token with the `project` scope of an account that can edit the board.
  Without it the commands still work on the issues, but the board is not updated.
- `DISCORD_WEBHOOK`: the URL of a Discord webhook for the channel that announces tasks. Without it nothing is posted
  to Discord.
