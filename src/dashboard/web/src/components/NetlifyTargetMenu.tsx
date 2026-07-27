import { Box, Button, Group, Menu, Stack, Text } from '@mantine/core'
import { Check, Cloud, ExternalLink, TriangleAlert } from 'lucide-react'
import type { DashboardLinkedNetlifySite, DashboardNetlifyContext } from '../types'

type Props = {
  context?: DashboardNetlifyContext
}

function LinkedSiteItem({ site, selected }: { site: DashboardLinkedNetlifySite; selected: boolean }) {
  const content = (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <Box miw={0}>
        <Text size="sm" fw={selected ? 800 : 600} truncate>{site.name}</Text>
        <Text c="dimmed" ff="monospace" size="xs" truncate>{site.source}</Text>
      </Box>
      <Group gap={5} wrap="nowrap">
        {selected ? <Check aria-label="Agent Runner target" color="var(--mantine-color-green-6)" size={15} /> : null}
        {!site.accessible ? <TriangleAlert aria-label={`Access check: ${site.accessCode}`} color="var(--mantine-color-yellow-6)" size={15} /> : null}
        {site.adminUrl ? <ExternalLink aria-hidden size={13} /> : null}
      </Group>
    </Group>
  )
  if (!site.adminUrl) return <Menu.Item>{content}</Menu.Item>
  return (
    <Menu.Item component="a" href={site.adminUrl} rel="noreferrer" target="_blank">
      {content}
    </Menu.Item>
  )
}

export function NetlifyTargetMenu({ context }: Props) {
  if (!context) return null
  const target = context.target
  const label = target?.name || 'Target unresolved'
  return (
    <Menu position="bottom-end" shadow="md" width={430} withinPortal>
      <Menu.Target>
        <Button
          aria-label={`Agent Runner site: ${label}`}
          className="header-netlify-target"
          color={target?.accessible ? 'violet' : 'yellow'}
          leftSection={<Cloud size={14} />}
          size="xs"
          variant="light"
        >
          Agent runs · {label}
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
          />
        )) : (
          <Text c="dimmed" px="sm" pb="sm" size="xs">No .netlify/state.json links found.</Text>
        )}
      </Menu.Dropdown>
    </Menu>
  )
}
