import { ActionIcon, Box, Button, Group, Menu, Stack, Text } from '@mantine/core'
import { Check, Cloud, ExternalLink, TriangleAlert } from 'lucide-react'
import type { DashboardLinkedNetlifySite, DashboardNetlifyContext } from '../types'

type Props = {
  context?: DashboardNetlifyContext
  onSelect?: (siteId: string) => void
}

function LinkedSiteItem({ site, selected, onSelect }: {
  site: DashboardLinkedNetlifySite
  selected: boolean
  onSelect?: (siteId: string) => void
}) {
  return (
    <Menu.Item
      closeMenuOnClick={false}
      aria-label={`Select Agent Runner target ${site.name}`}
      onClick={() => onSelect?.(site.siteId)}
      leftSection={selected
        ? <Check aria-label="Selected Agent Runner target" color="var(--mantine-color-green-6)" size={15} />
        : <Box w={15} />}
      rightSection={(
        <Group gap={6} wrap="nowrap">
          {!site.accessible ? <TriangleAlert aria-label={`Access check: ${site.accessCode}`} color="var(--mantine-color-yellow-6)" size={15} /> : null}
          {site.adminUrl ? (
            <ActionIcon
              aria-label={`Open ${site.name} agent runs`}
              component="a"
              href={site.adminUrl}
              rel="noreferrer"
              target="_blank"
              size="sm"
              variant="subtle"
              color="gray"
              onClick={(event) => event.stopPropagation()}
            >
              <ExternalLink size={13} />
            </ActionIcon>
          ) : null}
        </Group>
      )}
    >
      <Box miw={0}>
        <Text size="sm" fw={selected ? 800 : 600} truncate>{site.name}</Text>
        <Text c="dimmed" ff="monospace" size="xs" truncate>{site.source}</Text>
      </Box>
    </Menu.Item>
  )
}

export function NetlifyTargetMenu({ context, onSelect }: Props) {
  if (!context) return null
  const target = context.target
  const label = target?.name || 'Target unresolved'
  return (
    <Menu position="bottom-end" shadow="md" width={430} withinPortal>
      <Menu.Target>
        <Button
          aria-label={`Netlify project: ${label}`}
          className="header-netlify-target"
          color={target?.accessible ? 'gray' : 'yellow'}
          leftSection={<Cloud size={14} />}
          size="xs"
          variant="subtle"
        >
          Netlify project · {label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Agent Runner target</Menu.Label>
        <Stack gap={4} px="sm" pb="sm">
          <Text fw={800} size="sm">{label}</Text>
          <Text c="dimmed" size="xs">
            {target?.reason || context.targetError || 'No target selection details are available.'}
          </Text>
          {target?.adminUrl ? (
            <Text
              c="violet"
              component="a"
              href={target.adminUrl}
              rel="noreferrer"
              size="xs"
              target="_blank"
            >
              Open Agent Runs <ExternalLink aria-hidden size={11} style={{ verticalAlign: '-1px' }} />
            </Text>
          ) : null}
        </Stack>
        <Menu.Divider />
        <Menu.Label>Locally linked sites ({context.linkedSites.length})</Menu.Label>
        {context.linkedSites.length > 0 ? context.linkedSites.map((site) => (
          <LinkedSiteItem
            key={`${site.siteId}:${site.source}`}
            site={site}
            selected={site.siteId === target?.siteId}
            onSelect={onSelect}
          />
        )) : (
          <Text c="dimmed" px="sm" pb="sm" size="xs">No .netlify/state.json links found.</Text>
        )}
      </Menu.Dropdown>
    </Menu>
  )
}
