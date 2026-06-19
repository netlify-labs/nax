import { createTheme } from '@mantine/core'

export const theme = createTheme({
  primaryColor: 'blue',
  colors: {
    blue: [
      '#defffe',
      '#b5fcfa',
      '#8efbf7',
      '#5ef0ec',
      '#3ae8e4',
      '#24e0dc',
      '#14d8d4',
      '#05bdba',
      '#04a29f',
      '#02807d',
    ],
    dark: [
      '#f0f4f8',
      '#d0d8e0',
      '#b0b8c2',
      '#4d565f',
      '#3b434c',
      '#272f38',
      '#1e242c',
      '#12181f',
      '#060b10',
      '#060b10',
    ],
  },
  components: {
    Badge: {
      styles: {
        label: {
          textTransform: 'none',
          '&::firstLetter': {
            textTransform: 'uppercase',
          },
        },
      },
    },
    Select: {
      defaultProps: {
        checkIconPosition: 'right',
      },
    },
  },
})
