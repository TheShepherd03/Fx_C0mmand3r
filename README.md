# FX Commander 📊⚡

**Professional MetaTrader 5 Dashboard for Real-Time Trading Insights**

FX Commander is a sleek, modern React Native application that provides comprehensive MetaTrader 5 integration with real-time account monitoring, position management, signal tracking, and trade control capabilities.

![React Native](https://img.shields.io/badge/React%20Native-0.81-blue)
![Expo](https://img.shields.io/badge/Expo-54.0-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![Firebase](https://img.shields.io/badge/Firebase-12.9-orange)

## 🚀 Features

### 📈 **Dashboard**
- **Real-time Account Overview**: Balance, equity, margin, and free margin
- **Interactive Equity Curve**: Visual representation of account performance
- **Dark/Light Theme Toggle**: Automatic system theme detection
- **Multi-Account Support**: Switch between multiple MT5 accounts

### 📊 **Portfolio Management**
- **Live Position Tracking**: Real-time position updates
- **Position Details**: Comprehensive P&L calculations, risk analysis
- **Bulk Operations**: Close all positions with confirmation
- **Profit/Loss Indicators**: Color-coded position status

### 📡 **Market Signals**
- **Real-Time Signal Feed**: Live trading signal notifications
- **Signal Analytics**: Entry price, stop loss, take profit levels
- **Strategy Identification**: Signal source and methodology
- **Historical Signal Tracking**: Complete signal history

### ⚡ **Trade Control**
- **Emergency Controls**: Kill switch for critical situations
- **Global Settings**: Trading permissions and risk controls
- **Account Management**: Real-time account switching
- **Safety Confirmations**: Protected critical operations

## 🛠 Technical Stack

- **Frontend**: React Native 0.81 with Expo 54
- **Navigation**: Expo Router with tab-based navigation
- **State Management**: React Context API
- **Backend**: Firebase Realtime Database
- **Charts**: React Native Chart Kit
- **Styling**: Dynamic theming with TypeScript
- **Icons**: Expo Symbols with SF Symbols

## 📱 Installation

### Prerequisites
- Node.js 18+ 
- Expo CLI
- MetaTrader 5 with Bridge EA configured
- Firebase project with Realtime Database

### Setup Instructions

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/fx-commander.git
   cd fx-commander
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure Firebase**
   - Update `firebaseConfig.ts` with your Firebase credentials
   - Set up Realtime Database rules for security

4. **Start the development server**
   ```bash
   npm start
   ```

5. **Run on device**
   - **Expo Go**: Scan QR code (limited functionality)
   - **Development Build**: Recommended for full feature access
   - **Emulator/Simulator**: Android Studio or Xcode

## 🔧 Configuration

### Firebase Database Structure
```json
{
  "accounts": {
    "accountId": {
      "balance": 10000,
      "equity": 10500,
      "margin": 1000,
      "freeMargin": 9500,
      "marginLevel": 1050,
      "positions": [...],
      "history": [...]
    }
  },
  "signals": {
    "signalId": {
      "symbol": "EURUSD",
      "type": "BUY",
      "price": 1.0850,
      "sl": 1.0800,
      "tp": 1.0950,
      "timestamp": 1640995200,
      "strategy": "Breakout"
    }
  }
}
```

### MetaTrader 5 Integration
- Install the provided Bridge EA in your MT5 terminal
- Configure Firebase credentials in EA settings
- Enable real-time data synchronization

## 🎨 Customization

### Themes
The app supports automatic dark/light theme switching with:
- System theme detection
- Manual toggle override
- Persistent theme preferences
- Professional color schemes

### Branding
Easily customize:
- App name and description in `app.json`
- Color schemes in theme configuration
- Icons and splash screens
- Tab names and navigation

## 📊 Performance

### Optimizations
- **Real-time Updates**: Firebase real-time listeners
- **Efficient Rendering**: React Native optimization
- **Memory Management**: Proper cleanup and disposal
- **Network Efficiency**: Minimal data transfer

### Monitoring
- Real-time position tracking
- Sub-second account updates
- Instant signal notifications
- Responsive UI interactions

## 🚀 Deployment

### Development Build
```bash
eas build --platform android
eas build --platform ios
```

### Production Release
```bash
eas submit --platform android
eas submit --platform ios
```

### Web Deployment
```bash
npx expo export -p web
```

## 🧪 Testing

### Running Tests
```bash
npm test
```

### Manual Testing Checklist
- [ ] Account switching functionality
- [ ] Real-time position updates
- [ ] Theme toggle behavior
- [ ] Signal reception and display
- [ ] Emergency controls confirmation
- [ ] Multi-device synchronization

## 📋 System Requirements

### Minimum Requirements
- **iOS**: 13.0+
- **Android**: API 21+ (Android 5.0)
- **RAM**: 2GB minimum, 4GB recommended
- **Storage**: 100MB available space

### Recommended
- **iOS**: 15.0+
- **Android**: API 30+ (Android 11)
- **RAM**: 8GB+
- **Network**: Stable internet for real-time updates

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ⚡ Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm start

# Run on Android
npm run android

# Run on iOS  
npm run ios

# Run on Web
npm run web
```

## 📞 Support

For support and questions:
- Create an issue on GitHub
- Check the documentation
- Review Firebase configuration
- Verify MT5 EA installation

## 🔄 Updates

The app automatically checks for updates and provides seamless OTA updates through Expo.

---

**Built with ❤️ for professional traders using React Native and Expo**
