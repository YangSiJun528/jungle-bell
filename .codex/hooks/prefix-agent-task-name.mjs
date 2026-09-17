const managedRoles = new Set([
    'jb_frontend',
    'jb_desktop',
    'jb_server',
    'jb_reviewer',
    'jb_visual_qa',
]);

const spawnTools = new Set([
    'spawn_agent',
    'Agent',
    'collaboration.spawn_agent',
    'collaborationspawn_agent',
]);

function prefixedArguments(event) {
    if (event?.hook_event_name !== 'PreToolUse' || !spawnTools.has(event.tool_name)) {
        return null;
    }

    const args = event.tool_input;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;

    const role = args.agent_type;
    const name = args.task_name;
    if (!managedRoles.has(role) || typeof name !== 'string' || name.length === 0) return null;
    if (name === role || name.startsWith(`${role}_`)) return null;

    return {...args, task_name: `${role}_${name}`};
}

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

let event;
try {
    event = JSON.parse(input);
} catch {
    // 잘못된 훅 입력도 호출을 차단하지 않는다.
    process.exit(0);
}

const updatedInput = prefixedArguments(event);
if (updatedInput) {
    process.stdout.write(
        `${JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput,
            },
        })}\n`,
    );
}
